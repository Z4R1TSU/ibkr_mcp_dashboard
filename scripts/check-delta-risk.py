"""Read-only held-option verification; never prints account values or credentials."""
import asyncio
import json
import sys
import tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'integrations/thinkorswim'))
from settings import settings, read_private
from state import State
from wire import Wire
from universe import read_universe
from holding_greeks import contract, subscribe_holding, DeltaVerifier

async def main():
    config = settings()
    symbols, _ = read_universe(config['directory'])
    held = [contract(s) for s in symbols if contract(s)][:20]
    verifier = DeltaVerifier()
    wire = Wire(config['proxy'], lambda: None)
    with tempfile.TemporaryDirectory(prefix='delta-check-') as tmp:
        state = State(Path(tmp))
        try:
            await wire.open(read_private(config['directory'] / 'session.json')['token'])
            for item in held:
                try:
                    subscription = await subscribe_holding(wire, item, state, verifier=verifier)
                    row = None
                    for _ in range(20):
                        row = state.view(['holdingGreeks'])['holdingGreeks'].get(item['symbol'])
                        if row:
                            break
                        await asyncio.sleep(.25)
                    print(json.dumps({'symbol': item['symbol'], 'delta': row.get('values', {}).get('DELTA') if row else None,
                        'basis': row.get('deltaBasis') if row else 'missing', 'multiplier': row.get('multiplier') if row else None}), flush=True)
                    await subscription.close()
                except Exception as e:
                    print(json.dumps({'symbol': item['symbol'], 'error': type(e).__name__}), flush=True)
        finally:
            await wire.close()

asyncio.run(main())
