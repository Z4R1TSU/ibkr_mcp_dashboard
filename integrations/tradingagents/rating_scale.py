"""Five research ratings for the dashboard's pinned TradingAgents workflow."""
from contextlib import contextmanager
from enum import StrEnum
import re

from pydantic import Field
from tradingagents.agents import schemas


class ResearchRating(StrEnum):
    STRONG_BUY = "strong buy"
    BUY = "buy"
    HOLD = "hold"
    SELL = "sell"
    STRONG_SELL = "strong sell"


RATINGS = tuple(item.value for item in ResearchRating)
SCALE = " / ".join(RATINGS)


class ResearchPlan(schemas.ResearchPlan):
    recommendation: ResearchRating = Field(description="Research recommendation. Exactly one of " + SCALE)


class PortfolioDecision(schemas.PortfolioDecision):
    rating: ResearchRating = Field(description="Final research rating. Exactly one of " + SCALE)


def rating_prompt(value):
    if isinstance(value, list):
        return [rating_prompt(item) for item in value]
    if isinstance(value, dict):
        return {**value, "content": rating_prompt(value["content"])} if "content" in value else value
    if not isinstance(value, str):
        return value
    value = value.replace("Buy / Overweight / Hold / Underweight / Sell", SCALE)
    for old, new in zip(("Buy", "Overweight", "Hold", "Underweight", "Sell"), RATINGS):
        value = value.replace("- **" + old + "**:", "- **" + new + "**:")
    return value.replace(
        "recommendation of Overweight is a Buy and Underweight is a Sell,",
        "recommendation of strong buy or buy is a Buy, and sell or strong sell is a Sell,",
    )


class RatingModel:
    def __init__(self, model):
        self.model = model

    def invoke(self, prompt, *args, **kwargs):
        return self.model.invoke(rating_prompt(prompt), *args, **kwargs)

    def with_structured_output(self, schema, *args, **kwargs):
        schema = {schemas.ResearchPlan: ResearchPlan, schemas.PortfolioDecision: PortfolioDecision}.get(schema, schema)
        return RatingModel(self.model.with_structured_output(schema, *args, **kwargs))


_RATING_LINE = re.compile(
    r"^[ \t*_#]*(?:(?:final|overall)[ \t]+)?(?:rating|最终评级|研究评级|评级)"
    r"[ \t*_]*[:：][ \t*_]*(strong[ \t]+buy|strong[ \t]+sell|buy|hold|sell)"
    r"[ \t*_.。]*$", re.IGNORECASE | re.MULTILINE,
)


def final_rating(state):
    text = state.get("final_trade_decision", "")
    match = _RATING_LINE.search(text)
    parsed = " ".join(match.group(1).lower().split()) if match else None
    rating = state.get("final_rating")
    if rating not in RATINGS:
        rating = parsed or "REVIEW"
    if match and parsed == rating:
        state = {**state, "final_trade_decision": text[:match.start(1)] + rating + text[match.end(1):]}
    return {**state, "final_rating": rating}


@contextmanager
def rating_scale():
    import tradingagents.graph.setup as setup
    names = ("create_research_manager", "create_trader", "create_portfolio_manager")
    originals = {name: getattr(setup, name) for name in names}
    try:
        for name, original in originals.items():
            def factory(llm, _original=original, _final=name == "create_portfolio_manager"):
                node = _original(RatingModel(llm))
                return (lambda state: final_rating(node(state))) if _final else node
            setattr(setup, name, factory)
        yield
    finally:
        for name, original in originals.items():
            setattr(setup, name, original)
