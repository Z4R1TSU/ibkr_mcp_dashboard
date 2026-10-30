"""Named facts and explicit binary comparisons; no guessed paragraph subjects."""
import math
import json
import re

LEVELS = {"latest", "mark", "last", "bid", "ask", "regularClose", "regularLast", "close",
          "open", "high", "low", "close_10_ema", "close_50_sma", "close_200_sma",
          "boll", "boll_ub", "boll_lb", "vwma"}
MACD = {"macd", "macds", "macdh"}
TOKEN = re.compile(r"\[\[price:([a-zA-Z0-9_.-]+)\]\]")
ALIASES = {
    "latest": ("研究启动参考价", "盘前参考价", "最新参考价", "当前股价", "当前价格", "最新股价", "最新价", "现价"),
    "close": ("历史日线收盘价", "历史日线收盘", "历史收盘价", "历史收盘", "前收盘价", "前收盘"),
    "close_10_ema": ("10日EMA", "10日均线"),
    "close_50_sma": ("50日SMA", "50日均线"),
    "close_200_sma": ("200日SMA", "200日均线"),
    "boll_lb": ("布林带下轨", "布林下轨"), "boll_ub": ("布林带上轨", "布林上轨"),
    "boll": ("布林带中轨", "布林中轨"), "vwma": ("VWMA", "成交量加权均价"),
    "macd": ("MACD线", "MACD"), "macds": ("MACD信号线", "信号线"),
}
NAMES = {name.lower(): key for key, names in ALIASES.items() for name in names}
ENTITY = "(?:" + "|".join(re.escape(x) for x in sorted(NAMES, key=len, reverse=True)) + ")"
MOD = r"(?:已经|仍然|同时|明显|显著|略微|略|仍|已|又|大幅|目前|也)*"


def comparable(left, right):
    level = lambda k: k in LEVELS or k.startswith("close.")
    return level(left) and level(right) or left in MACD and right in MACD


DIRECT = re.compile(r"(?P<left>" + ENTITY + ")" + MOD + r"(?P<op>高于|低于|等于|跌破|站上)(?P<right>" + ENTITY + r")", re.I)
LOCATION = re.compile(r"(?P<left>" + ENTITY + ")" + MOD + r"(?:位于|处于|在)(?P<right>" + ENTITY + r")(?:的)?(?P<op>上方|下方)", re.I)
PASSIVE = re.compile(r"(?P<right>" + ENTITY + ")" + MOD + r"被(?P<left>" + ENTITY + r")(?P<op>跌破|站上)", re.I)
NUMBER = r"[-+]?\d+(?:,\d{3})*(?:\.\d+)?"
LITERAL = re.compile(r"(?P<entity>" + ENTITY + r")(?:为|是|约为|约|[:：=|])?\s*\$?\s*(?P<number>" + NUMBER + r")(?:\s*(?:美元|USD))?", re.I)
CURRENT_CLOSE = re.compile(r"(?:现价|最新价|当前股价|当前价格)(?:为|是|[:：=])?\s*\[\[price:close(?:\.[\d-]+)?\]\]")


def issue(code, severity, message, paragraph, snippet, **evidence):
    return {"code": code, "severity": severity, "message": message,
            "paragraph": paragraph, "snippet": snippet[:600], "evidence": evidence,
            "repair": severity == "error" or code in ("unbound_comparison", "ambiguous_comparison", "unbound_price_number")}


def inspect_block(context, block, index):
    masked = TOKEN.sub(lambda m: " " * len(m[0]), block)
    issues, replacements, spans = [], [], []
    for pattern in (DIRECT, LOCATION, PASSIVE):
        for match in pattern.finditer(masked):
            if any(a <= match.start() < b for a, b in spans):
                continue
            left, right = NAMES[match["left"].lower()], NAMES[match["right"].lower()]
            spans.append(match.span())
            if not comparable(left, right) or any(k not in context.facts or "value" not in context.facts[k] for k in (left, right)):
                issues.append(issue("unbound_comparison", "unverified", "比较对象无法对应已知数值", index, match[0], left=left, right=right))
                continue
            prefix = re.split(r"[。\n，,；;]", masked[:match.start()])[-1]
            prefix = re.sub(r"^[\s*\-\d.)、]+", "", prefix).strip()
            suffix = re.split(r"[。\n，,；;]", masked[match.end():])[0].strip(" *")
            if prefix and prefix != context.ticker or suffix:
                code = "unbound_comparison" if re.search(ENTITY, suffix, re.I) else "qualified_comparison"
                issues.append(issue(code, "unverified", "复合或带限定语的比较未作自动事实判定", index, match[0], left=left, right=right))
                continue
            key = context.comparison(left, right)
            expected = context.facts[key]["relation"]
            claimed = {"上方": "高于", "站上": "高于", "下方": "低于", "跌破": "低于"}.get(match["op"], match["op"])
            if claimed != expected:
                issues.append(issue("comparison_mismatch", "error", "明确比较与数值矛盾", index, match[0],
                                    **context.facts[key], claimed=claimed))
            else:
                replacements.append((match.start(), match.end(), "[[price:" + key + "]]"))
    return finish_block(context, block, masked, index, issues, replacements, spans)


def finish_block(context, block, masked, index, issues, replacements, spans):
    for match in LITERAL.finditer(masked):
        if any(a <= match.start() < b for a, b in spans):
            continue
        if re.match(r"[-年/]\d", masked[match.end():]):
            continue
        key = NAMES[match["entity"].lower()]
        spans.append(match.span())
        prefix = re.split(r"[。\n，,；;]", masked[:match.start()])[-1]
        prefix = re.sub(r"^[\s*#|\-\d.)、]+", "", prefix).strip()
        if prefix and prefix != context.ticker:
            issues.append(issue("unbound_price_number", "unverified", "带限定语的数值需要明确引用", index, match[0], reference=key))
            continue
        raw = match["number"].replace(",", "")
        actual = float(raw)
        expected = context.facts.get(key, {}).get("value")
        decimals = len(raw.partition(".")[2]) if "." in raw else 0
        tolerance = 0.5 * 10 ** -decimals + 1e-9
        if expected is None or not math.isfinite(actual) or abs(actual - expected) > tolerance:
            issues.append(issue("literal_mismatch", "error", "明确数值与来源不符", index, match[0],
                                reference=key, actual=actual, expected=expected))
        else:
            replacements.append((match.start(), match.end(), "[[price:" + key + "]]"))
    return residual_block(context, block, masked, index, issues, replacements, spans)


def residual_block(context, block, masked, index, issues, replacements, spans):
    residual = list(masked)
    for start, end in spans:
        residual[start:end] = " " * (end - start)
    residual = "".join(residual)
    for clause in re.split(r"[。\n，,；;]", residual):
        subject = re.search(r"现价|最新价|股价|参考价|当前价格|价格", clause)
        if subject and re.search(r"高于|低于|上方|下方|跌破|站上", clause[subject.end():]):
            issues.append(issue("ambiguous_comparison", "unverified", "价格比较未明确绑定左右对象", index, clause))
        if re.search(r"(?:目标价|止损价|支撑位|阻力位)\s*[:：为|]?\s*\$?\s*" + NUMBER, clause):
            issues.append(issue("unsupported_level", "error", "价位缺少来源引用", index, clause))
    for start, end, value in sorted(replacements, reverse=True):
        block = block[:start] + value + block[end:]
    return block, issues


def inspect_report(context, text, require_latest=False):
    issues, output = [], []
    for index, block in enumerate(re.split(r"\n\s*\n", text)):
        for match in TOKEN.finditer(block):
            key = match[1]
            if key.startswith("compare.") and key not in context.refs:
                pair = key.removeprefix("compare.").split("__")
                if len(pair) == 2 and all(k in context.facts and "value" in context.facts[k] for k in pair) and comparable(*pair):
                    context.comparison(*pair)
            if key not in context.refs:
                issues.append(issue("unknown_reference", "error", "报告引用了未知价格事实", index, match[0], reference=key))
        if "[[price:" in TOKEN.sub("", block):
            issues.append(issue("malformed_reference", "error", "价格引用格式无效", index, block))
        if CURRENT_CLOSE.search(block):
            issues.append(issue("close_as_current", "error", "历史收盘被用作当前价格", index, block))
        normalized, found = inspect_block(context, block, index)
        output.append(normalized)
        issues.extend(found)
    normalized = "\n\n".join(output)
    if require_latest and "[[price:latest]]" not in normalized:
        issues.append(issue("missing_latest", "error", "报告未引用研究启动报价", None, ""))
    return {"status": "blocked" if any(i["severity"] == "error" for i in issues) else "passed",
            "text": normalized, "issues": issues}


def guard_section(context, text, rewrite=None, include_facts=False):
    if "latest" not in context.facts:
        return text, {"status": "skipped", "issues": [], "reason": "没有价格上下文"}
    first = context.inspect(text)
    targets = sorted({i["paragraph"] for i in first["issues"] if i["repair"] and i["paragraph"] is not None})
    blocks = re.split(r"\n\s*\n", first["text"])
    attempted = False
    if targets and rewrite:
        attempted = True
        response = rewrite([{"index": i, "text": blocks[i]} for i in targets], first["issues"])
        try:
            parsed = json.loads(response)
            updates = {row["index"]: row["text"] for row in parsed
                       if isinstance(row, dict) and type(row.get("index")) is int and isinstance(row.get("text"), str)}
        except (ValueError, TypeError, KeyError):
            updates = {}
        for i in targets:
            if updates.get(i, "").strip():
                blocks[i] = updates[i]
    return finish_guard(context, text, first, blocks, targets, attempted, include_facts)


def finish_guard(context, original, first, blocks, targets, attempted, include_facts):
    checked = context.inspect("\n\n".join(blocks))
    remaining = {i["paragraph"] for i in checked["issues"] if i["repair"] and i["paragraph"] is not None}
    if checked["status"] == "blocked":
        body = "本章节的价格分析未能完成核验，改为呈现可核验的事实。"
    else:
        body = "\n\n".join(b for i, b in enumerate(re.split(r"\n\s*\n", checked["text"])) if i not in remaining)
    if include_facts or remaining or checked["status"] == "blocked":
        body += "\n\n" + context.fact_table()
    final = context.inspect(body)
    if final["status"] == "blocked":
        raise ValueError("程序生成的价格事实未通过核验")
    trace = {"status": "corrected" if targets else "passed", "rewriteAttempted": attempted,
             "fallback": bool(remaining or checked["status"] == "blocked"),
             "issues": first["issues"], "remainingIssues": final["issues"],
             "original": original, "text": final["text"]}
    return final["text"], trace
