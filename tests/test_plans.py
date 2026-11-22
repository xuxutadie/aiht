"""检查固定引导的完整性边界，不调用任何语言模型。"""

import unittest

from studio.contracts import DomainError
from studio.plans import build_prompt, build_preview, build_summary, missing_fields, sanitize_answers


def complete_answers():
    return {
        "task_understanding": "用画面表现城市与自然的关系", "theme": "给小鸟让路的城市",
        "reason": "我发现小区的大树越来越少", "message": "城市也要给小生命留下空间",
        "message_detail": "楼顶树林连接成绿色通道", "subject": "城市里的小鸟",
        "scene": "未来城市楼顶", "action": "沿着树林飞行", "details": "小鸟停在树梢",
        "ratio": "16:9", "style": "水彩", "style_reason": "自然温暖的色彩适合主题",
        "innovation_type": "新的组合", "innovation": "让高楼和小树林连接",
        "innovation_visible": "每栋楼的屋顶留出树木和鸟巢",
    }


class PlansTests(unittest.TestCase):
    def test_incomplete_draft_can_save_but_cannot_generate(self):
        answers = sanitize_answers({"theme": "未来城市"})
        self.assertTrue(missing_fields(answers))
        with self.assertRaises(DomainError):
            build_prompt(answers)

    def test_invalid_ratio_and_hidden_fields_rejected(self):
        for values in ({"ratio": "1000:1"}, {"api_key": "not-a-real-key"}, {"theme": ["不是文本"]}):
            with self.assertRaises(DomainError):
                sanitize_answers(values)

    def test_template_contains_own_message_and_visible_innovation(self):
        answers = complete_answers()
        self.assertEqual(missing_fields(answers), [])
        prompt = build_prompt(answers)
        self.assertIn(answers["message"], prompt)
        self.assertIn(answers["innovation_visible"], prompt)
        self.assertIn("16:9", prompt)
        self.assertNotIn("phone", prompt)

    def test_description_is_editable_honest_template(self):
        summary = build_summary(complete_answers())
        self.assertIn("给小鸟让路的城市", summary)
        self.assertIn("修改", summary)
        self.assertNotIn("获奖", summary)

    def test_legacy_answers_and_auto_framing_keep_original_prompt(self):
        answers = complete_answers()
        self.assertEqual(missing_fields(answers), [])
        self.assertEqual(build_prompt({**answers, "subject_framing": "自动", "scene_distance": "自动"}), build_prompt(answers))
        for field, values in (("subject_framing", ("全身", "半身", "特写")),
                              ("scene_distance", ("远景", "中景", "近景"))):
            for value in values:
                self.assertIn(value, build_prompt({**answers, field: value}))
            with self.assertRaises(DomainError) as caught:
                sanitize_answers({field: "其他"})
            self.assertEqual(caught.exception.code, "invalid_choice")

    def test_manual_prompt_limit_and_original_guidance_are_enforced(self):
        answers = {**complete_answers(), "custom_prompt": "字" * 4000}
        self.assertEqual(len(build_prompt(answers)), 4000)
        with self.assertRaises(DomainError) as caught:
            sanitize_answers({"custom_prompt": "字" * 4001})
        self.assertEqual(caught.exception.code, "answer_too_long")
        with self.assertRaises(DomainError) as caught:
            build_prompt({**answers, "message": ""})
        self.assertEqual(caught.exception.code, "incomplete_plan")

    def test_empty_manual_prompt_can_be_a_draft_but_cannot_generate(self):
        self.assertEqual(sanitize_answers({"custom_prompt": " \n "})["custom_prompt"], "")
        with self.assertRaises(DomainError) as caught:
            build_prompt({**complete_answers(), "custom_prompt": " \n "})
        self.assertEqual(caught.exception.code, "empty_prompt")

    def test_long_automatic_template_does_not_block_short_manual_prompt(self):
        answers = {**complete_answers(), "custom_prompt": "我手动精简后的画面描述"}
        for field in ("theme", "subject", "scene", "action", "details", "message", "message_detail", "innovation"):
            answers[field] = "字" * 600
        self.assertEqual(build_prompt(answers), answers["custom_prompt"])
        preview = build_preview(answers)
        self.assertEqual(preview["prompt"], answers["custom_prompt"])
        self.assertEqual(preview["template_prompt"], "")
        self.assertIn("精简", preview["template_error"])
        self.assertEqual(preview["missing"], [])
        del answers["custom_prompt"]
        with self.assertRaises(DomainError) as caught:
            build_prompt(answers)
        self.assertEqual(caught.exception.code, "prompt_too_long")


if __name__ == "__main__":
    unittest.main()
