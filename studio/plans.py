"""预设问题与规则模板：只整理学生答案，不调用语言模型。"""

from .contracts import DomainError

FIELD_LABELS = {
    "competition_name": "比赛或练习名称", "competition_theme": "赛题主题", "requirements": "赛题要求",
    "task_understanding": "我理解的任务", "theme": "作品主题", "reason": "创作缘由",
    "message": "表达目的", "message_detail": "表达对应的画面细节", "subject": "画面主角",
    "scene": "画面场景", "action": "发生的事情", "details": "关键细节", "ratio": "画面比例",
    "style": "画面风格", "style_reason": "形式选择理由", "innovation_type": "创新思考路径",
    "innovation": "具体创新点", "innovation_visible": "创新在画面中的表现",
}
REQUIRED = tuple(key for key in FIELD_LABELS if key not in {"competition_name", "competition_theme", "requirements"})
RATIOS = {"1:1", "4:3", "3:4", "16:9", "9:16"}
STYLES = {"动漫", "写实", "水彩", "拼贴", "版画"}
INNOVATION_TYPES = {"新的组合", "不同的视角", "特别的用途", "新的故事"}
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
        maximum = 1500 if key == "requirements" else 600
        if len(text) > maximum or "\x00" in text:
            raise DomainError(400, "answer_too_long", f"{FIELD_LABELS[key]}最多填写{maximum}字。")
        result[key] = text.strip()
    choices = {"ratio": RATIOS, "style": STYLES, "innovation_type": INNOVATION_TYPES}
    for key, options in choices.items():
        if result.get(key) and result[key] not in options:
            raise DomainError(400, "invalid_choice", f"请选择有效的{FIELD_LABELS[key]}。")
    return result


def missing_fields(answers: dict) -> list[str]:
    values = sanitize_answers(answers)
    return [FIELD_LABELS[key] for key in REQUIRED if not values.get(key)]


def build_prompt(answers: dict) -> str:
    values = sanitize_answers(answers)
    missing = missing_fields(values)
    if missing:
        raise DomainError(400, "incomplete_plan", "请先补充：" + "、".join(missing) + "。")
    # 只拼接与画面有关的字段，不把姓名、手机号等注册资料发给绘图模型。
    parts = [
        f"创作一幅主题为《{values['theme']}》的完整绘画。",
        f"主体：{values['subject']}。场景：{values['scene']}。发生的事：{values['action']}。",
        f"关键细节：{values['details']}。",
        f"表达意图：{values['message']}；通过{values['message_detail']}让观众理解。",
        f"创新构思：{values['innovation']}；画面表现：{values['innovation_visible']}。",
        f"采用{values['style']}风格，画面比例{values['ratio']}。构图清楚，细节围绕主题。",
    ]
    prompt = "\n".join(parts)
    if len(prompt) > 4000:
        raise DomainError(400, "prompt_too_long", "画面描述较长，请适当精简主体、细节和创新点后再生成。")
    return prompt


def build_summary(answers: dict) -> str:
    values = sanitize_answers(answers)
    def field(name):
        return values.get(name) or "【请补充】"
    return (
        f"作品名称：《{field('theme')}》\n\n"
        f"创作缘由：{field('reason')}\n"
        f"我想表达：{field('message')}\n"
        f"画面设计：以{field('subject')}为主角，在{field('scene')}，{field('action')}。"
        f"关键细节是{field('details')}。\n"
        f"形式选择：{field('ratio')}画幅，{field('style')}风格。选择理由：{field('style_reason')}\n"
        f"我的创新：{field('innovation')}。在画面中通过{field('innovation_visible')}体现。\n\n"
        "AI辅助与修改过程：【请根据实际生成、检查和修改过程填写，不要保留这一提示文字。】"
    )
