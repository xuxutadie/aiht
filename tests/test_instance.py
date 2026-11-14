"""独占锁必须跨进程生效，并在进程退出时由操作系统自动释放。"""

from pathlib import Path
import queue
import subprocess
import sys
import tempfile
import threading
import unittest

from studio.contracts import DomainError
from studio.instance import InstanceLock


PROJECT_ROOT = Path(__file__).resolve().parent.parent


class InstanceLockTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.data_dir = Path(self.directory.name)

    def lock(self):
        result = InstanceLock(self.data_dir)
        self.addCleanup(result.release)
        return result

    def child(self, source):
        return subprocess.run([sys.executable, "-c", source, str(self.data_dir)],
                              cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=10)

    def test_same_process_second_instance_is_blocked_without_database_creation(self):
        first = self.lock()
        first.acquire()
        with self.assertRaises(DomainError) as caught:
            self.lock().acquire()
        self.assertEqual(caught.exception.status, 409)
        self.assertNotIn(str(self.data_dir), str(caught.exception))
        self.assertEqual({path.name for path in self.data_dir.iterdir()}, {".server.lock"})

    def test_release_allows_another_instance_and_repeated_release_is_safe(self):
        first, second = self.lock(), self.lock()
        first.acquire()
        first.release()
        first.release()
        second.acquire()
        second.release()
        first.acquire()

    def test_same_object_repeated_acquire_keeps_one_lock(self):
        first = self.lock()
        first.acquire()
        first.acquire()
        first.release()
        self.lock().acquire()

    def test_subprocess_cannot_acquire_while_parent_holds_lock(self):
        first = self.lock()
        first.acquire()
        result = self.child("""
from pathlib import Path
import sys
from studio.contracts import DomainError
from studio.instance import InstanceLock
try:
    InstanceLock(Path(sys.argv[1])).acquire()
except DomainError as error:
    print(error.status)
else:
    raise SystemExit(10)
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), "409")

    def test_child_owned_lock_blocks_parent_and_termination_releases_it(self):
        source = """
from pathlib import Path
import sys
from studio.instance import InstanceLock
lock = InstanceLock(Path(sys.argv[1]))
lock.acquire()
print('LOCKED', flush=True)
sys.stdin.buffer.read(1)
"""
        process = subprocess.Popen([sys.executable, "-c", source, str(self.data_dir)], cwd=PROJECT_ROOT,
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        def finish():
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)
        self.addCleanup(finish)
        ready = queue.Queue()
        threading.Thread(target=lambda: ready.put(process.stdout.readline()), daemon=True).start()
        self.assertEqual(ready.get(timeout=10).strip(), "LOCKED")
        with self.assertRaises(DomainError):
            self.lock().acquire()
        process.kill()
        process.wait(timeout=5)
        self.lock().acquire()

    def test_normal_and_abrupt_process_exit_release_without_explicit_unlock(self):
        for abrupt in (False, True):
            source = """
from pathlib import Path
import os
import sys
from studio.instance import InstanceLock
lock = InstanceLock(Path(sys.argv[1]))
lock.acquire()
print('LOCKED', flush=True)
"""
            if abrupt:
                source += "os._exit(7)\n"
            result = self.child(source)
            self.assertEqual(result.returncode, 7 if abrupt else 0, result.stderr)
            self.assertEqual(result.stdout.strip(), "LOCKED")
            parent = self.lock()
            parent.acquire()
            parent.release()


if __name__ == "__main__":
    unittest.main()
