"""密码散列必须可验证，且拒绝畸形和超长输入。"""

import unittest

from studio.auth import hash_password, verify_password
from studio.contracts import DomainError


class PasswordTests(unittest.TestCase):
    def test_password_uses_independent_salt_and_verifies(self):
        first = hash_password("学生密码12345")
        second = hash_password("学生密码12345")
        self.assertNotEqual(first, second)
        self.assertTrue(first.startswith("scrypt$"))
        self.assertNotIn("学生密码", first)
        self.assertTrue(verify_password("学生密码12345", first))
        self.assertFalse(verify_password("密码错误12345", first))

    def test_password_boundaries_reject_before_hashing(self):
        for value in ("1234567", "a" * 129, None, 12345678):
            with self.subTest(value=type(value).__name__):
                with self.assertRaises(DomainError):
                    hash_password(value)

    def test_invalid_hash_and_oversized_login_are_not_authenticated(self):
        self.assertFalse(verify_password("12345678", "畸形散列"))
        self.assertFalse(verify_password("a" * 129, "scrypt$1$1$1$x$x"))

    def test_malformed_unicode_password_has_a_safe_validation_error(self):
        with self.assertRaises(DomainError):
            hash_password("12345678\ud800")


if __name__ == "__main__":
    unittest.main()
