"""Carry selected live Worker settings into the Wrangler config for deployment."""

import json
import os
import sys
import tomllib
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen


MAIL_VARS = (
    "MAIL_STORAGE_BACKEND",
    "MAIL_STORAGE_R2_GZIP",
    "ENABLE_TG_PUSH_ATTACHMENT",
    "ENABLE_AI_EMAIL_EXTRACT",
    "AI_EXTRACT_MODEL",
    "CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST",
)

DOMAIN_LIST_VARS = ("DOMAINS", "DEFAULT_DOMAINS")


class ConfigurationError(Exception):
    """A safe error message that can be printed to CI logs."""


def cloudflare_get(path, token, *, worker_may_be_missing=False):
    request = Request(
        "https://api.cloudflare.com/client/v4" + path,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )

    try:
        with urlopen(request, timeout=20) as response:
            payload = json.load(response)
    except HTTPError as error:
        if error.code == 404 and worker_may_be_missing:
            try:
                errors = json.load(error).get("errors", [])
            except (ValueError, AttributeError):
                errors = []
            if any(item.get("code") == 10007 for item in errors):
                return None
        raise ConfigurationError(f"Cloudflare settings lookup returned HTTP {error.code}.") from None
    except (URLError, TimeoutError, ValueError):
        raise ConfigurationError("Cloudflare settings lookup failed.") from None

    if payload.get("success") is not True or not isinstance(payload.get("result"), dict):
        raise ConfigurationError("Unexpected response from Cloudflare settings lookup.")
    return payload["result"]


def active_bindings(get, worker_path):
    result = get(worker_path + "/deployments", worker_may_be_missing=True)
    if result is None:
        return []
    deployments = result.get("deployments")
    if not isinstance(deployments, list):
        raise ConfigurationError("Cloudflare did not return a deployment list.")
    if not deployments:
        return []

    versions = deployments[0].get("versions", [])
    if len(versions) != 1 or versions[0].get("percentage") != 100 or not versions[0].get("version_id"):
        raise ConfigurationError("Finish the staged Worker rollout before publishing a new version.")

    version_path = worker_path + "/versions/" + quote(versions[0]["version_id"], safe="")
    version = get(version_path)
    bindings = version.get("resources", {}).get("bindings")
    if not isinstance(bindings, list):
        raise ConfigurationError("Cloudflare did not return the active Worker's bindings.")
    return bindings


def preserve_mail_settings(config, bindings):
    live = {entry["name"]: entry for entry in bindings}
    if "MAIL_STORAGE" in live:
        entry = live["MAIL_STORAGE"]
        bucket = entry.get("bucket_name")
        if entry.get("type") != "r2_bucket" or not isinstance(bucket, str) or not bucket:
            raise ConfigurationError("The live MAIL_STORAGE binding must point to an R2 bucket.")

        r2 = {"binding": "MAIL_STORAGE", "bucket_name": bucket}
        if entry.get("jurisdiction") not in (None, "", "default"):
            r2["jurisdiction"] = entry["jurisdiction"]

        other_buckets = [item for item in config.get("r2_buckets", []) if item["binding"] != "MAIL_STORAGE"]
        config["r2_buckets"] = [*other_buckets, r2]

    variables = config.setdefault("vars", {})
    for name in (*MAIL_VARS, *DOMAIN_LIST_VARS):
        if name not in live:
            continue
        item = live[name]
        value = item.get("text") if item.get("type") == "plain_text" else item.get("json")
        if name in DOMAIN_LIST_VARS:
            if not (isinstance(value, str) or
                    isinstance(value, list) and all(isinstance(domain, str) for domain in value)):
                raise ConfigurationError(f"The live {name} setting must be text or an array of domains.")
        elif not isinstance(value, (str, bool)):
            raise ConfigurationError(f"The live {name} setting must be text or a boolean.")
        variables[name] = value

    mode = variables.get("MAIL_STORAGE_BACKEND", "d1")
    if mode not in ("d1", "r2"):
        raise ConfigurationError("MAIL_STORAGE_BACKEND must be d1 or r2.")
    if mode == "r2" and not any(
        item.get("binding") == "MAIL_STORAGE" and item.get("bucket_name")
        for item in config.get("r2_buckets", [])
    ):
        raise ConfigurationError("R2 writes are enabled but MAIL_STORAGE has no bucket. Deployment stopped.")


def main(input_path, output_path):
    with open(input_path, "rb") as source:
        config = tomllib.load(source)
    account = os.environ.get("CLOUDFLARE_ACCOUNT_ID") or config.get("account_id")
    token = os.environ.get("CLOUDFLARE_API_TOKEN")
    worker = config.get("name")
    if not account or not worker or not token:
        raise ConfigurationError("Worker name and Cloudflare deployment credentials are required.")
    if config.get("account_id") not in (None, account):
        raise ConfigurationError("Wrangler and CI specify different Cloudflare accounts.")

    path = f"/accounts/{quote(account, safe='')}/workers/scripts/{quote(worker, safe='')}"
    bindings = active_bindings(lambda route, **opts: cloudflare_get(route, token, **opts), path)
    preserve_mail_settings(config, bindings)
    # The generated file contains the original secret config. Restrict its permissions.
    content = json.dumps(config, indent=2)
    with open(output_path, "x", opener=lambda path, flags: os.open(path, flags, 0o600)) as output:
        output.write(content + "\n")
    print("Prepared Wrangler config with active Worker mail settings.")


if __name__ == "__main__":
    try:
        main(*sys.argv[1:])
    except ConfigurationError as error:
        sys.exit(str(error))
    except (OSError, TypeError, ValueError, KeyError, AttributeError):
        sys.exit("Unable to prepare Wrangler config. Check the deployment config and Cloudflare settings.")
