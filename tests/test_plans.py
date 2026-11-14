"""检查固定引导的完整性边界，不调用任何语言模型。"""

import unittest

from studio.contracts import DomainError
from studio.plans import build_prompt, build_summary, missing_fields, sanitize_answers


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


if __name__ == "__main__":
    unittest.main()
