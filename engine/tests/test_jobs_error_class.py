"""Stage 3: unified job error taxonomy (mirrors shared/contracts ErrorClass)."""

from __future__ import annotations

import unittest

from engine.jobs import JobRegistry, classify_error


def _run_to_completion(worker):
    registry = JobRegistry(max_workers=1)
    try:
        start = registry.start("test", "test", worker)
        job_id = start["job_id"]
        for _ in range(500):
            status = registry.status(job_id)
            if status["status"] not in ("queued", "running", "cancelling"):
                return status
            import time

            time.sleep(0.01)
        raise AssertionError("job never settled")
    finally:
        registry.close()


class ClassifyError(unittest.TestCase):
    def test_message_table(self):
        cases = {
            "找不到图层：x": "INPUT_ERROR",
            "距离必须为正数": "INPUT_ERROR",
            "RuntimeError: unreachable": "EXECUTION_ERROR",
            "已取消，未生成结果": "USER_CANCELLED",
            "导出超时": "RESOURCE_LIMIT",
            "验收未通过：数量不符": "VALIDATION_ERROR",
            "whatever": "EXECUTION_ERROR",
        }
        for message, expected in cases.items():
            self.assertEqual(classify_error(message), expected, message)

    def test_hints_win_over_text(self):
        self.assertEqual(classify_error("anything", cancelled=True), "USER_CANCELLED")
        self.assertEqual(classify_error("anything", timeout=True), "RESOURCE_LIMIT")


class JobErrorClass(unittest.TestCase):
    def test_failed_job_carries_error_class(self):
        def worker(job, report):
            raise RuntimeError("找不到图层：nope")

        status = _run_to_completion(worker)
        self.assertEqual(status["status"], "failed")
        self.assertEqual(status["error_class"], "INPUT_ERROR")

    def test_engine_crash_is_execution_error(self):
        def worker(job, report):
            raise RuntimeError("unreachable")

        status = _run_to_completion(worker)
        self.assertEqual(status["error_class"], "EXECUTION_ERROR")

    def test_cancelled_job_is_user_cancelled(self):
        def worker(job, report):
            import time

            for _ in range(100):
                time.sleep(0.02)
                report(0.5, "working")
            return {"ok": True}

        registry = JobRegistry(max_workers=1)
        try:
            import time

            start = registry.start("test", "slow", worker)
            job_id = start["job_id"]
            for _ in range(200):
                if registry.status(job_id)["status"] == "running":
                    break
                time.sleep(0.01)
            registry.cancel(job_id)
            for _ in range(500):
                status = registry.status(job_id)
                if status["status"] not in ("queued", "running", "cancelling"):
                    break
                time.sleep(0.01)
            self.assertEqual(status["status"], "cancelled")
            self.assertEqual(status["error_class"], "USER_CANCELLED")
        finally:
            registry.close()


if __name__ == "__main__":
    unittest.main()
