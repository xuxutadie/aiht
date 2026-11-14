"""数据目录的进程生命周期锁：先独占，再打开数据库并恢复任务。

锁由操作系统维护，不依据 PID 或锁文件是否存在判断服务状态。
进程崩溃后锁会自动释放；锁文件保留，避免删除重建造成两个锁对象。
"""

import errno
import os
from pathlib import Path
import threading

if os.name == "nt":
    import msvcrt
else:
    import fcntl

from .contracts import DomainError


class InstanceLock:
    """同一数据目录只允许一个服务；acquire 非阻塞，release 可重复调用。"""

    def __init__(self, data_dir):
        self.data_dir = Path(data_dir).resolve()
        self.path = self.data_dir / ".server.lock"
        self._descriptor = None
        self._mutex = threading.Lock()

    def acquire(self):
        with self._mutex:
            if self._descriptor is not None:
                return self
            descriptor = None
            try:
                # 此处只创建目录与锁文件；不得打开、初始化或改写数据库。
                self.data_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_BINARY", 0), 0o600)
                os.set_inheritable(descriptor, False)
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"\x00")
                os.lseek(descriptor, 0, os.SEEK_SET)
            except OSError:
                if descriptor is not None:
                    os.close(descriptor)
                raise DomainError(500, "instance_lock_unavailable", "无法锁定服务器数据目录，请检查目录权限。") from None
            try:
                if os.name == "nt":
                    # 锁定首字节；LK_NBLCK 遇到重复服务立即失败，不等待。
                    msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
                else:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                os.close(descriptor)
                if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise DomainError(409, "instance_already_running", "此数据目录已有作品创作台正在运行，请使用已打开的服务。") from None
                raise DomainError(500, "instance_lock_unavailable", "无法锁定服务器数据目录，请检查目录权限。") from None
            self._descriptor = descriptor
            return self

    def release(self):
        with self._mutex:
            descriptor = self._descriptor
            if descriptor is None:
                return
            self._descriptor = None
            try:
                os.lseek(descriptor, 0, os.SEEK_SET)
                if os.name == "nt":
                    msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(descriptor, fcntl.LOCK_UN)
            except OSError:
                # 关闭文件描述符本身也会释放系统锁，不能因解锁异常跳过关闭。
                pass
            finally:
                os.close(descriptor)
