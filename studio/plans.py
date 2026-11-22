"""预设问题与规则模板：只整理学生答案，不调用语言模型。"""

from .contracts import DomainError

FIELD_LABELS = {
    "competition_name": "比赛或练习名称", "competition_theme": "赛题主题", "requirements": "赛题要求",
    "task_understanding": "我理解的任务", "theme": "作品主题", "reason": "创作缘由",
    "message": "表达目的", "message_detail": "表达对应的画面细节", "subject": "画面主角",
    "scene": "画面场景", "action": "发生的事情", "details": "关键细节", "ratio": "画面比例",
    "style": "画面风格", "style_reason": "形式选择理由", "innovation_type": "创新思考路径",
    "innovation": "具体创新点", "innovation_visible": "创新在画面中的表现",
    "subject_framing": "主体呈现", "scene_distance": "场景景别", "custom_prompt": "手动改写提示词",
}
# 新增字段可选，避免旧草稿因界面扩充而失去完整性。
OPTIONAL = {"competition_name", "competition_theme", "requirements", "subject_framing", "scene_distance", "custom_prompt"}
REQUIRED = tuple(key for key in FIELD_LABELS if key not in OPTIONAL)
RATIOS = {"1:1", "4:3", "3:4", "16:9", "9:16"}
STYLES = {"动漫", "写实", "水彩", "拼贴", "版画"}
INNOVATION_TYPES = {"新的组合", "不同的视角", "特别的用途", "新的故事"}
SUBJECT_FRAMINGS = {"自动", "全身", "半身", "特写"}
SCENE_DISTANCES = {"自动", "远景", "中景", "近景"}
DEFAULT_ANSWERS = {
    "competition_name": "创意练习（可改为实际比赛）",
    "competition_theme": "未来城市与自然共生",
    "requirements": "这是一份练习任务。用画面表达城市与自然的关系，并说清自己的创作缘由与创新点。实际比赛请按老师提供的规则填写。",
}


def sanitize_answers(value: dict) -> dict:
    if not isinstance(value, dict) or len(value) > len(FIELD_LABELS):
        raise DomainError(400, "invalid_answers", "创作内容格式不正确。")
    result = {}
    for key, text in value.items():
        if key not in FIELD_LABELS or not isinstance(text, str):
            raise DomainError(400, "invalid_answers", "请使用规定的创作信息字段，并填写文字。")
        maximum = 4000 if key == "custom_prompt" else 1500 if key == "requirements" else 600
        if len(text) > maximum or "\x00" in text or any(0xD800 <= ord(character) <= 0xDFFF for character in text):
            raise DomainError(400, "answer_too_long", f"{FIELD_LABELS[key]}最多填写{maximum}字。")
        result[key] = text.strip()
    choices = {"ratio": RATIOS, "style": STYLES, "innovation_type": INNOVATION_TYPES,
               "subject_framing": SUBJECT_FRAMINGS, "scene_distance": SCENE_DISTANCES}
    for key, options in choices.items():
        if result.get(key) and result[key] not in options:
            raise DomainError(400, "invalid_choice", f"请选择有效的{FIELD_LABELS[key]}。")
    return result


def missing_fields(answers: dict) -> list[str]:
    values = sanitize_answers(answers)
    return [FIELD_LABELS[key] for key in REQUIRED if not values.get(key)]


def _require_complete(values: dict):
    missing = missing_fields(values)
    if missing:
        raise DomainError(400, "incomplete_plan", "请先补充：" + "、".join(missing) + "。")


def _framing_text(values: dict) -> str:
    parts = []
    if values.get("subject_framing") and values["subject_framing"] != "自动":
        parts.append(f"主体呈现：{values['subject_framing']}。")
    if values.get("scene_distance") and values["scene_distance"] != "自动":
        parts.append(f"场景景别：{values['scene_distance']}。")
    return "".join(parts)


def _template_text(values: dict) -> str:
    # 只拼接与画面有关的字段，不把姓名、手机号等注册资料发给绘图模型。
    parts = [
        f"创作一幅主题为《{values['theme']}》的完整绘画。",
        f"主体：{values['subject']}。场景：{values['scene']}。发生的事：{values['action']}。",
        f"关键细节：{values['details']}。",
        f"表达意图：{values['message']}；通过{values['message_detail']}让观众理解。",
        f"创新构思：{values['innovation']}；画面表现：{values['innovation_visible']}。",
        _framing_text(values),
        f"采用{values['style']}风格，画面比例{values['ratio']}。构图清楚，细节围绕主题。",
    ]
    return "\n".join(part for part in parts if part)


def _checked_prompt(prompt: str) -> str:
    if len(prompt) > 4000:
        raise DomainError(400, "prompt_too_long", "画面描述较长，请适当精简主体、细节和创新点后再生成。")
    return prompt


def build_template_prompt(answers: dict) -> str:
    values = sanitize_answers(answers)
    _require_complete(values)
    return _checked_prompt(_template_text(values))


def build_prompt(answers: dict) -> str:
    values = sanitize_answers(answers)
    _require_complete(values)
    if "custom_prompt" in values:
        if not values["custom_prompt"]:
            raise DomainError(400, "empty_prompt", "手动改写的提示词为空，请填写内容或恢复根据回答整理的提示词。")
        return _checked_prompt(values["custom_prompt"])
    return _checked_prompt(_template_text(values))


def build_preview(answers: dict) -> dict:
    values = sanitize_answers(answers)
    missing = missing_fields(values)
    # 自动模板不受空白手改内容影响，便于学生恢复；框架缺项仍须先补充。
    template = "" if missing else _template_text(values)
    custom = "custom_prompt" in values
    if custom and not values["custom_prompt"]:
        missing.append(FIELD_LABELS["custom_prompt"])
    result = {"prompt": "" if missing else build_prompt(values), "missing": missing,
              "summary": build_summary(values), "template_prompt": "" if len(template) > 4000 else template,
              "prompt_mode": "custom" if custom else "template"}
    if len(template) > 4000:
        result["template_error"] = "根据回答整理的提示词超过4000字，请先精简原答案后再恢复。"
    return result


def build_summary(answers: dict) -> str:
    values = sanitize_answers(answers)
    framing = _framing_text(values)
    framing_line = f"取景选择：{framing}\n" if framing else ""
    def field(name):
        return values.get(name) or "【请补充】"
    return (
        f"作品名称：《{field('theme')}》\n\n"
        f"创作缘由：{field('reason')}\n"
        f"我想表达：{field('message')}\n"
        f"画面设计：以{field('subject')}为主角，在{field('scene')}，{field('action')}。"
        f"关键细节是{field('details')}。\n"
        f"{framing_line}"
        f"形式选择：{field('ratio')}画幅，{field('style')}风格。选择理由：{field('style_reason')}\n"
        f"我的创新：{field('innovation')}。在画面中通过{field('innovation_visible')}体现。\n\n"
        "AI辅助与修改过程：【请根据实际生成、检查和修改过程填写，不要保留这一提示文字。】"
    )
