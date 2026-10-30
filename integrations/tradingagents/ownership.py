"""Form 4 transaction codes and security classes, without sentiment inference."""
import xml.etree.ElementTree as ET
from evidence import record, citation, SourceResult
from public_data import SourceUnavailable

CODES = {"P": "买入（公开市场或私人交易，需看脚注）", "S": "卖出（公开市场或私人交易，需看脚注）",
         "G": "赠与", "M": "行权或转换", "C": "转换", "F": "税款或行权价扣缴",
         "A": "授予或奖励", "D": "向发行人处置", "J": "其他（见脚注）", "U": "要约处置"}


def parse_form4(body, cik, filing, receipt):
    if "<!ENTITY" in body.upper() or "<!DOCTYPE" in body.upper():
        raise SourceUnavailable("Form 4 XML 不接受外部实体")
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise SourceUnavailable("Form 4 XML 格式无效") from None
    if int(root.findtext("issuer/issuerCik", "0")) != cik:
        raise SourceUnavailable("Form 4 发行人不匹配")
    names = [n.text for n in root.findall("reportingOwner/reportingOwnerId/rptOwnerName") if n.text]
    records = []
    for group, derivative in (("nonDerivativeTable/nonDerivativeTransaction", False),
                              ("derivativeTable/derivativeTransaction", True)):
        for i, tx in enumerate(root.findall(group)):
            def value(path):
                return tx.findtext(path + "/value") or tx.findtext(path) or None
            code = tx.findtext("transactionCoding/transactionCode", "")
            records.append(record("SEC Form 4", receipt["url"], receipt["fetchedAt"],
                filing["publishedAt"], revision=filing["accessionNumber"], content_level="structured",
                locator=group + ":" + str(i), period=value("transactionDate"), unit="股数/每股价格按原文",
                security=value("securityTitle"), derivative=derivative, owners=names,
                transactionCode=code, transactionType=CODES.get(code, "未知代码：" + code),
                shares=value("transactionAmounts/transactionShares"),
                price=value("transactionAmounts/transactionPricePerShare"),
                acquiredDisposed=value("transactionAmounts/transactionAcquiredDisposedCode"),
                amended=filing["form"].endswith("/A"),
                footnotes=[n.text or "" for n in root.findall("footnotes/footnote")]))
    if not records:
        records.append(record("SEC Form 4", receipt["url"], receipt["fetchedAt"], filing["publishedAt"],
            revision=filing["accessionNumber"], owners=names, transactions=[], reason="申报没有交易条目"))
    return records


def ownership_report(records, complete):
    lines = ["## SEC 内部人申报",
             "发行人层面的申报按证券类别分别呈现，不等同于所研究股票的公开市场买卖。"
             "赠与、行权、扣税及修订申报不推断看多或看空，不直接汇总为资金流。"]
    seen = set()
    for row in records:
        if row["url"] not in seen:
            lines += [citation(row)]
            if row.get("footnotes"):
                lines.append("本申报原文脚注：" + " ".join(row["footnotes"])[:1800])
            seen.add(row["url"])
        if "transactionCode" not in row:
            lines.append(row["reason"])
            continue
        lines.append(f"交易日：{row['period'] or '未知'}；人员：{', '.join(row['owners'])}；"
                     f"证券：{row['security'] or '未知'}；衍生品：{'是' if row['derivative'] else '否'}；"
                     f"代码：{row['transactionCode']}（{row['transactionType']}）；"
                     f"股数：{row['shares'] if row['shares'] is not None else '未知'}；"
                     f"每股价格原值：{row['price'] if row['price'] is not None else '未知'}；修订：{row['amended']}")
    if not records:
        lines.append("已检查的披露窗口内未发现 Form 4；不推定没有未披露交易。")
    reason = "" if complete else "申报数量超出本次读取上限或部分原文失败，仅展示已取得记录"
    return SourceResult("\n\n".join(lines), records, "verified" if complete else "partial", reason)
