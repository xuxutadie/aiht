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
        answers = complete_answers()
        summary = build_summary(answers)
        sections = ("01 赛题理解", "02 创作背景", "03 表达意图", "04 画面构思",
                    "05 设计选择", "06 创新亮点", "07 AI辅助与修改过程")
        self.assertTrue(summary.startswith("作品名称：《给小鸟让路的城市》"))
        for section in sections:
            self.assertIn(section, summary)
        self.assertEqual(list(map(summary.index, sections)), sorted(map(summary.index, sections)))
        for value in answers.values():
            self.assertIn(value, summary)
        self.assertIn("创作计划", summary)
        self.assertIn("提示词", summary)
        self.assertIn("AI绘图", summary)
        self.assertIn("实际生成过程：【请根据实际情况补充", summary)
        self.assertIn("检查与修改：【请根据实际情况补充", summary)
        for fabricated in ("获奖", "经过多次生成", "反复调试", "已经修改", "通过评审"):
            self.assertNotIn(fabricated, summary)

    def test_summary_optional_fields_and_missing_answers(self):
        answers = {**complete_answers(), "competition_name": "创作比赛", "competition_theme": "人机共生",
                   "requirements": "展示人和机器共同生活的画面", "subject_framing": "全身", "scene_distance": "中景"}
        summary = build_summary(answers)
        for value in ("比赛或练习名称：创作比赛", "赛题主题：人机共生", "赛题要求：展示人和机器共同生活的画面",
                      "主体呈现：全身", "场景景别：中景"):
            self.assertIn(value, summary)
        draft = build_summary({"theme": "未来城市", "subject_framing": "自动", "scene_distance": "自动"})
        for optional in ("比赛或练习名称：", "赛题主题：", "赛题要求：", "主体呈现：", "场景景别："):
            self.assertNotIn(optional, draft)
        self.assertIn("创作缘由：【请补充】", draft)
        self.assertIn("具体创新点：【请补充】", draft)

    def test_summary_of_maximum_length_answers_fits_description_without_losing_sections(self):
        answers = {**complete_answers(), "competition_name": "长比赛名", "competition_theme": "长赛题主题",
                   "requirements": "长赛题要求", "custom_prompt": "独立手改提示词" * 500,
                   "subject_framing": "半身", "scene_distance": "近景"}
        free_fields = tuple(key for key in answers if key not in ("ratio", "style", "innovation_type", "subject_framing", "scene_distance", "custom_prompt"))
        prefixes = {key: f"原回答-{index}-" for index, key in enumerate(free_fields)}
        for key in free_fields:
            limit = 1500 if key == "requirements" else 600
            answers[key] = (prefixes[key] + "🚀" * limit)[:limit]
        answers["custom_prompt"] = (answers["custom_prompt"] + "字" * 4000)[:4000]
        original = dict(answers)
        summary = build_summary(answers)
        self.assertLessEqual(len(summary), 5000)
        self.assertLessEqual(len(summary.encode("utf-16-le")) // 2, 5000)
        for prefix in prefixes.values():
            self.assertIn(prefix, summary)
        self.assertIn("原回答已摘录", summary)
        self.assertIn("07 AI辅助与修改过程", summary)
        self.assertIn("检查与修改：【请根据实际情况补充", summary)
        self.assertNotIn("独立手改提示词", summary)
        self.assertEqual(answers, original)
        self.assertEqual(build_prompt(answers), original["custom_prompt"])
        self.assertEqual(build_preview(answers)["summary"], summary)

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
