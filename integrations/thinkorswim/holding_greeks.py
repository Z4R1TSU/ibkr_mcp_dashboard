"""Exact held contracts; per-share Delta checked against a same-strike C/P pair."""
import re
import asyncio
from market import number, quotes, timestamp
DELTA_BASIS = 'per-share-feed-v1'
PATTERN = re.compile(r'^\.([A-Z]{1,10})(\d{6})([CP])(\d+(?:\.\d{1,3})?)$')

def contract(symbol):
    match = PATTERN.fullmatch(symbol)
    if not match:
        return None
    underlying, day, right, strike = match.groups()
    return dict(symbol=symbol, underlying=underlying, expiry=f'20{day[:2]}-{day[2:4]}-{day[4:]}', right=right, strike=float(strike))

def match_series(body, held):
    rows = [r for r in body.get('series', []) if r.get('underlying') == held['underlying']
            and r.get('spc') == 100 and r.get('multiplier') == 100
            and str(r.get('lastTradeDate') or r.get('expiration') or '')[:10] == held['expiry']
            and isinstance(r.get('name'), str)]
    if len(rows) != 1:
        raise ValueError('standard_series_not_matched')
    return rows[0]

def match_pair(body, series, held):
    rows = [r for r in body.get('optionSeries', []) if r.get('name') == series['name']]
    pairs = [p for r in rows for p in r.get('optionPairs', []) if p.get('strike') == held['strike']]
    if len(rows) != 1 or len(pairs) != 1:
        raise ValueError('held_strike_not_matched')
    pair = pairs[0]
    for right, field in [('C', 'callSymbol'), ('P', 'putSymbol')]:
        parsed = contract(pair.get(field, ''))
        if not parsed or any(parsed[k] != held[k] for k in ('underlying', 'expiry', 'strike')) or parsed['right'] != right:
            raise ValueError('held_contract_not_matched')
    return pair

def stamp_fields(rows, saved, body, kind, patch):
    """Only an explicit field snapshot/patch confirms that field's freshness."""
    indexes = {r.get('symbol'): i for i, r in enumerate(body.get('items', []))}
    paths = [p.get('path', '') for p in (patch or {}).get('patches', [])]
    for symbol, row in rows.items():
        old = saved.get(symbol, {})
        times = dict(old.get('fieldTimes', {}))
        for field in row['returnedFields']:
            target = f'/items/{indexes[symbol]}/values/{field}'
            if kind == 'snapshot' or any(target == p or target.startswith(p + '/') for p in paths):
                times[field] = row['receivedAt']
        row['fieldTimes'] = times

class DeltaVerifier:
    def __init__(self):
        self.proof = None

    def observe(self, rows, pair):
        c = rows.get(pair['callSymbol'], {}).get('values', {}).get('DELTA')
        p = rows.get(pair['putSymbol'], {}).get('values', {}).get('DELTA')
        if number(c) is not None and number(p) is not None and 0 <= c <= 1 and -1 <= p <= 0 and abs(c - p - 1) <= 0.1:
            self.proof = dict(callSymbol=pair['callSymbol'], putSymbol=pair['putSymbol'], callDelta=c, putDelta=p)


def verified_rows(body, pair, series, saved, kind='snapshot', patch=None, verifier=None):
    rows = quotes(body, {pair['callSymbol'], pair['putSymbol']}, timestamp(), option=True)
    stamp_fields(rows, saved, body, kind, patch)
    verifier = verifier or DeltaVerifier()
    verifier.observe(rows, pair)
    for row in rows.values():
        delta = row['values'].get('DELTA')
        right = contract(row['symbol'])['right']
        valid = number(delta) is not None and (0 <= delta <= 1 if right == 'C' else -1 <= delta <= 0)
        row['deltaBasis'] = DELTA_BASIS if verifier.proof and valid else 'unverified'
        row['deltaVerification'] = verifier.proof
        row['multiplier'] = series['multiplier']
        row['sharesPerContract'] = series['spc']
        row['contract'] = contract(row['symbol'])
    return rows

class HoldingSubscription:
    """Renew the bounded subscription to explicitly confirm unchanged Delta fields."""
    def __init__(self, wire, params, callback, ready=None):
        self.wire, self.params, self.callback = wire, params, callback
        self.ready = ready or (lambda response: True)
        self.request_id = None

    async def discard(self, request_id):
        if request_id is None:
            return
        key = ('quotes/options', request_id)
        try:
            await self.wire.send('unsubscribe', {'targetService': key[0], 'targetRequestId': request_id})
        finally:
            self.wire.handlers.pop(key, None)
            self.wire.bases.pop(key, None)
            self.wire.subscription_errors.pop(key, None)

    async def refresh(self, timeout=5):
        previous = self.request_id
        confirmed = asyncio.Event()
        def receive(response):
            if not confirmed.is_set() and not self.ready(response):
                return
            self.callback(response)
            confirmed.set()
        replacement = await self.wire.subscribe('quotes/options', self.params, receive)
        try:
            await asyncio.wait_for(confirmed.wait(), timeout)
        except BaseException:
            await self.discard(replacement)
            raise
        self.request_id = replacement
        await self.discard(previous)

    async def close(self):
        previous, self.request_id = self.request_id, None
        await self.discard(previous)

async def subscribe_holding(wire, held, state, series_body=None, verifier=None):
    series = match_series(series_body or await wire.request('optionSeries', {'underlying': held['underlying']}), held)
    scope = {'seriesNames': [series['name']], 'minStrike': held['strike'], 'maxStrike': held['strike']}
    body = await wire.request('option_chain/get', {'underlyingSymbol': held['underlying'], 'filter': scope})
    pair = match_pair(body, series, held)
    def update(response):
        saved = state.view(['holdingGreeks'])['holdingGreeks']
        try:
            rows = verified_rows(response, pair, series, saved, wire.current_kind, getattr(wire, 'current_patch', None), verifier)
            saved.update(rows)
            state.update('holdingGreeks', saved)
        except (ValueError, KeyError, TypeError):
            saved.pop(held['symbol'], None)
            state.update('holdingGreeks', saved)
    subscription = HoldingSubscription(wire, {'underlyingSymbol': held['underlying'], 'exchange': 'BEST',
        'fields': ['BID', 'ASK', 'DELTA'], 'filter': scope}, update,
        ready=lambda response: any(row.get('symbol') == held['symbol'] and number(row.get('values', {}).get('DELTA')) is not None
            for row in response.get('items', [])))
    await subscription.refresh()
    return subscription
