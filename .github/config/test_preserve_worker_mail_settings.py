import importlib.util
import io
from pathlib import Path
import unittest
from unittest.mock import Mock, call, patch
from urllib.error import HTTPError


spec = importlib.util.spec_from_file_location(
    "preserve_worker_mail_settings", Path(__file__).with_name("preserve-worker-mail-settings.py")
)
settings = importlib.util.module_from_spec(spec)
spec.loader.exec_module(settings)


class WorkerMailSettingsTest(unittest.TestCase):
    def test_active_version_is_selected(self):
        worker = "/accounts/example/workers/scripts/mail"
        bindings = [{"name": "MAIL_STORAGE_BACKEND", "type": "plain_text", "text": "r2"}]
        get = Mock(side_effect=[
            {"deployments": [{"versions": [{"version_id": "live", "percentage": 100}]}]},
            {"resources": {"bindings": bindings}},
        ])

        self.assertEqual(settings.active_bindings(get, worker), bindings)
        self.assertEqual(get.call_args_list, [
            call(worker + "/deployments", worker_may_be_missing=True),
            call(worker + "/versions/live"),
        ])

    def test_staged_rollout_fails_before_deploying(self):
        get = Mock(return_value={"deployments": [{"versions": [
            {"version_id": "a", "percentage": 80}, {"version_id": "b", "percentage": 20},
        ]}]})
        with self.assertRaisesRegex(settings.ConfigurationError, "staged Worker rollout"):
            settings.active_bindings(get, "/worker")

    def test_missing_worker_uses_bootstrap_config(self):
        error = HTTPError("", 404, "Not Found", {}, io.BytesIO(b'{"errors":[{"code":10007}]}'))
        with patch.object(settings, "urlopen", side_effect=error):
            self.assertIsNone(settings.cloudflare_get("/worker", "token", worker_may_be_missing=True))

    def test_settings_lookup_errors_stop_deployment(self):
        error = HTTPError("", 403, "Forbidden", {}, None)
        with patch.object(settings, "urlopen", side_effect=error):
            with self.assertRaisesRegex(settings.ConfigurationError, "HTTP 403"):
                settings.cloudflare_get("/worker", "token", worker_may_be_missing=True)

    def test_live_mail_settings_override_stale_toml_values(self):
        config = {
            "r2_buckets": [{"binding": "OTHER", "bucket_name": "unchanged"},
                           {"binding": "MAIL_STORAGE", "bucket_name": "previous"}],
            "vars": {"S3_BUCKET": "attachments", "MAIL_STORAGE_BACKEND": "d1",
                     "ENABLE_TG_PUSH_ATTACHMENT": False, "ENABLE_PLUS_ADDRESSING": True,
                     "ENABLE_AI_EMAIL_EXTRACT": "true", "AI_EXTRACT_MODEL": "old"},
        }
        settings.preserve_mail_settings(config, [
            {"name": "MAIL_STORAGE", "type": "r2_bucket", "bucket_name": "attachments",
             "jurisdiction": "eu"},
            {"name": "MAIL_STORAGE_BACKEND", "type": "plain_text", "text": "r2"},
            {"name": "MAIL_STORAGE_R2_GZIP", "type": "json", "json": False},
            {"name": "ENABLE_TG_PUSH_ATTACHMENT", "type": "json", "json": True},
            {"name": "ENABLE_AI_EMAIL_EXTRACT", "type": "plain_text", "text": "false"},
            {"name": "ENABLE_PLUS_ADDRESSING", "type": "json", "json": False},
            {"name": "AI_EXTRACT_MODEL", "type": "plain_text", "text": "selected"},
            {"name": "S3_BUCKET", "type": "plain_text", "text": "ignored"},
        ])
        self.assertEqual(config, {
            "r2_buckets": [{"binding": "OTHER", "bucket_name": "unchanged"},
                           {"binding": "MAIL_STORAGE", "bucket_name": "attachments",
                            "jurisdiction": "eu"}],
            "vars": {"S3_BUCKET": "attachments", "MAIL_STORAGE_BACKEND": "r2",
                     "MAIL_STORAGE_R2_GZIP": False, "ENABLE_TG_PUSH_ATTACHMENT": True,
                     "ENABLE_AI_EMAIL_EXTRACT": "false", "ENABLE_PLUS_ADDRESSING": False,
                     "AI_EXTRACT_MODEL": "selected"},
        })

    def test_d1_writes_retain_r2_reads(self):
        config = {}
        settings.preserve_mail_settings(config, [
            {"name": "MAIL_STORAGE", "type": "r2_bucket", "bucket_name": "mail",
             "jurisdiction": "default"},
            {"name": "MAIL_STORAGE_BACKEND", "type": "plain_text", "text": "d1"},
        ])
        self.assertEqual(config["vars"]["MAIL_STORAGE_BACKEND"], "d1")
        self.assertEqual(config["r2_buckets"], [{"binding": "MAIL_STORAGE", "bucket_name": "mail"}])

    def test_live_domains_preserve_order_default_and_legacy_text(self):
        domains = ["mail.example.net", "inbox.example.net"]
        config = {"vars": {"DOMAINS": ["old.example.net"], "DEFAULT_DOMAINS": ["old.example.net"],
                           "CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST": False}}
        settings.preserve_mail_settings(config, [
            {"name": "DOMAINS", "type": "json", "json": domains},
            {"name": "DEFAULT_DOMAINS", "type": "plain_text", "text": '["mail.example.net","inbox.example.net"]'},
            {"name": "CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST", "type": "json", "json": True},
        ])
        self.assertEqual(config["vars"], {
            "DOMAINS": domains,
            "DEFAULT_DOMAINS": '["mail.example.net","inbox.example.net"]',
            "CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST": True,
        })

    def test_live_domain_array_rejects_non_strings(self):
        with self.assertRaisesRegex(settings.ConfigurationError, "array of domains"):
            settings.preserve_mail_settings({}, [{"name": "DOMAINS", "type": "json", "json": [False]}])

    def test_initial_deployment_uses_toml_binding(self):
        config = {
            "vars": {"MAIL_STORAGE_BACKEND": "r2"},
            "r2_buckets": [{"binding": "MAIL_STORAGE", "bucket_name": "mail"}],
        }
        settings.preserve_mail_settings(config, [])
        self.assertEqual(config["r2_buckets"][0]["bucket_name"], "mail")

    def test_r2_mode_without_a_bucket_fails(self):
        with self.assertRaisesRegex(settings.ConfigurationError, "MAIL_STORAGE has no bucket"):
            settings.preserve_mail_settings({"vars": {"MAIL_STORAGE_BACKEND": "r2"}}, [])

    def test_live_binding_with_wrong_type_fails(self):
        with self.assertRaisesRegex(settings.ConfigurationError, "must point to an R2 bucket"):
            settings.preserve_mail_settings({}, [
                {"name": "MAIL_STORAGE", "type": "plain_text", "text": "not a bucket"},
            ])


if __name__ == "__main__":
    unittest.main()
