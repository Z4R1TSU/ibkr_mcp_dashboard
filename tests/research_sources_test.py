"""Offline source freshness, provenance, and free-tier regressions."""
from datetime import datetime, timezone
from pathlib import Path
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'integrations/tradingagents'))
import worker
from public_data import PublicClient, SourceUnavailable
from evidence import SourceResult, record
from sec_sources import SecSources, filings_at, filing_url, parse_release
from ownership import parse_form4
from news_sources import NewsSources, render_news, deduplicate
from valuation import valuation_result
from financials import FinancialBook
from data_runtime import DataRuntime


class SecFixture:
    def __init__(self):
        self.fail_release = False
    def json(self, url, **kwargs):
        if 'company_tickers' in url:
            body = {'0': {'ticker': 'TEST', 'cik_str': 123}}
        elif 'submissions' in url:
            body = submissions()
        else:
            body = financial_facts()
        return body, {'url': url, 'fetchedAt': CUTOFF.isoformat()}
    def get(self, url, **kwargs):
        if url.endswith('q3.htm'):
            body = '<a href="ex99-1.htm">Press release</a>'
        elif url.endswith('ex99-1.htm'):
            if self.fail_release:
                raise SourceUnavailable('SEC HTTP 403')
            body = RELEASE
        elif url.endswith('ownership.xml'):
            body = FORM4
        else:
            raise AssertionError(url)
        return {'url': url, 'fetchedAt': CUTOFF.isoformat(), 'body': body}


class FilingTests(unittest.TestCase):
    def test_revision_of_an_old_period_cannot_replace_a_newer_period(self):
        class Client(SecFixture):
            def json(self, url, **kwargs):
                body, receipt = super().json(url, **kwargs)
                if 'submissions' in url:
                    recent = body['filings']['recent']
                    recent['form'][0] = '10-Q/A'
                    recent['reportDate'][0] = '2025-03-31'
                return body, receipt
        source = SecSources('TEST', CUTOFF, Client())
        source.disclosures()
        self.assertEqual(source.periodic['reportDate'], '2026-06-30')

    def test_core_financials_must_cover_the_same_latest_period(self):
        raw = financial_facts()
        raw['facts']['us-gaap']['NetCashProvidedByUsedInOperatingActivities']['units']['USD'][0]['end'] = '2026-03-31'
        self.assertFalse(FinancialBook('TEST', '2026-10-29', raw).available)

    def test_form4_preserves_tax_gifts_derivatives_and_publication_dates(self):
        filing = filings_at(submissions(), CUTOFF)[1]
        receipt = {'url': filing_url(123, filing), 'fetchedAt': CUTOFF.isoformat()}
        rows = parse_form4(FORM4, 123, filing, receipt)
        self.assertEqual(rows[0]['transactionCode'], 'F')
        self.assertIn('扣缴', rows[0]['transactionType'])
        self.assertTrue(rows[0]['derivative'])
        self.assertEqual(rows[0]['period'], '2026-10-25')
        self.assertIn('2026-10-27', rows[0]['publishedAt'])
        gift = parse_form4(FORM4.replace('<transactionCode>F', '<transactionCode>G'), 123, filing, receipt)
        self.assertEqual(gift[0]['transactionType'], '赠与')
        with self.assertRaises(SourceUnavailable):
            parse_form4(FORM4, 456, filing, receipt)

    def test_filings_cannot_redirect_reads_to_an_arbitrary_host(self):
        row = filings_at(submissions(), CUTOFF)[0]
        for name in ['https://evil.test/x.htm', '../../x.htm', '/x.htm']:
            with self.assertRaises(SourceUnavailable):
                filing_url(123, row, name)

    def test_ratios_do_not_mix_filing_revisions(self):
        reference = {'start': '2026-01-01', 'end': '2026-06-30', 'unit': 'USD', 'accn': 'new'}
        self.assertIsNone(FinancialBook.match([{**reference, 'accn': 'old'}], reference))
        self.assertIsNotNone(FinancialBook.match([reference], reference))

    def test_old_eps_cannot_produce_current_ttm_valuation(self):
        book = FinancialBook('TEST', '2026-10-29', financial_facts())
        quote = {'reference': {'value': 290, 'receivedAt': CUTOFF.isoformat()}}
        result = valuation_result(book, '2026-09-30', quote, [])
        self.assertEqual(result.quality, 'partial')
        self.assertIn('TTM 市盈率：未知', result.text)
        self.assertNotIn('193.33', result.text)

    def test_verified_annual_eps_uses_the_new_quote(self):
        book = FinancialBook('TEST', '2026-10-29', financial_facts())
        book.rows['income_statement']['Diluted EPS'] = [
            {'span': 'annual', 'end': '2025-12-31', 'unit': 'USD/shares', 'val': 10, 'accn': 'annual'}]
        quote = {'reference': {'value': 290, 'receivedAt': CUTOFF.isoformat()}}
        source = {'source': 'SEC Company Facts', 'url': 'https://data.sec.gov/test',
                  'fetchedAt': CUTOFF.isoformat(), 'publishedAt': '2026-02-01'}
        result = valuation_result(book, '2025-12-31', quote, [source])
        self.assertEqual(result.quality, 'verified')
        self.assertIn('29.00', result.text)
    def test_new_earnings_is_read_before_old_companyfacts_are_used(self):
        source = SecSources('TEST', CUTOFF, SecFixture())
        result = source.financials()
        self.assertEqual(source.latest_period, '2026-09-30')
        self.assertEqual(source.book.latest_period, '2026-06-30')
        self.assertIn('不得称为最新季度数据', result.text)
        self.assertIn('127600', result.text)
        self.assertEqual(source.release['tables'][0]['rows'][0][-1], '2026 quarter')
        self.assertEqual(result.quality, 'verified')
        self.assertTrue(all('publishedAt' in r and 'revision' in r for r in result.records))

    def test_unread_new_release_does_not_fall_back_to_old_quarter_as_current(self):
        client = SecFixture()
        client.fail_release = True
        with self.assertRaises(SourceUnavailable):
            SecSources('TEST', CUTOFF, client).financials()

    def test_future_and_same_day_undated_filings_are_excluded(self):
        body = submissions()
        body['filings']['recent']['acceptanceDateTime'][0] = '2026-10-29T09:00:00Z'
        self.assertNotIn('8-K', [r['form'] for r in filings_at(body, CUTOFF)])
        body['filings']['recent']['acceptanceDateTime'][0] = ''
        body['filings']['recent']['filingDate'][0] = '2026-10-29'
        self.assertNotIn('8-K', [r['form'] for r in filings_at(body, CUTOFF)])


class ReleasePeriodTests(unittest.TestCase):
    """Issuer layouts seen in real 8-K Item 2.02 filings."""
    TABLE = ('<table><tr><td></td><td>Three Months Ended</td></tr>'
             '<tr><td></td><td>{0}</td><td>{1}</td></tr>'
             '<tr><td>Net revenue</td><td>16,513</td><td>13,653</td></tr></table>')

    def period(self, release, primary='', filed='2026-10-29'):
        return parse_release('<p>' + 'Results commentary. ' * 20 + '</p>' + release, primary, filed)['period']

    def test_abbreviated_table_header_with_8k_quarter_ended(self):
        primary = '<p>Item 2.02 Results. Results for its third quarter ended September 26, 2026.</p><p>Item 9.01</p>'
        self.assertEqual(self.period(self.TABLE.format('Sep 26, 2026', 'Sep 27, 2025'), primary), '2026-09-26')

    def test_header_split_across_rows_does_not_pair_day_with_wrong_year(self):
        table = ('<table><tr><td>Three Months Ended</td></tr><tr><td>July 26,</td><td>July 27,</td></tr>'
                 '<tr><td>2026</td><td>2025</td></tr><tr><td>Revenue</td><td>1</td><td>2</td></tr></table>')
        primary = '<p>Item 2.02 Results for the quarter ended July 26, 2026.</p>'
        self.assertEqual(self.period(table, primary, '2026-08-26'), '2026-07-26')

    def test_fiscal_year_end_mentioned_in_notes_is_not_the_reported_period(self):
        release = (self.TABLE.format('June 26, 2026', 'June 27, 2025')
                   + '<p>The fiscal years ended December 25, 2026 and December 26, 2025 are each 52 weeks.</p>')
        self.assertEqual(self.period(release, filed='2026-08-03'), '2026-06-26')

    def test_period_cited_from_another_filing_is_ignored(self):
        primary = ('<p>Item 2.02 Results. See the Quarterly Report on Form 10-Q for the quarter ended '
                   'March 31, 2026.</p>')
        self.assertEqual(self.period(self.TABLE.format('June 30, 2026', 'June 30, 2025'), primary,
                                     '2026-07-15'), '2026-06-30')

    def test_exhibit_located_by_index_row_when_link_text_is_a_title(self):
        class Client(SecFixture):
            def get(self, url, **kwargs):
                if url.endswith('q3.htm'):
                    return {'url': url, 'fetchedAt': CUTOFF.isoformat(),
                            'body': '<table><tr><td>99.1</td><td><a href="ex99-1.htm">News dated October 28</a></td></tr></table>'}
                return super().get(url, **kwargs)
        source = SecSources('TEST', CUTOFF, Client())
        source.disclosures()
        self.assertEqual(source.latest_period, '2026-09-30')

    def test_profit_loss_only_issuer_is_available_but_not_relabelled(self):
        raw = financial_facts()
        raw['facts']['us-gaap']['ProfitLoss'] = raw['facts']['us-gaap'].pop('NetIncomeLoss')
        book = FinancialBook('TEST', '2026-10-29', raw)
        self.assertTrue(book.available)
        self.assertEqual(book.rows['income_statement']['Net Income'], [])

    def test_gap_notice_shows_the_source_reason_not_a_generic_one(self):
        from data_notices import reason_text
        row = {'status': 'unavailable',
               'reason': 'DATA_UNAVAILABLE: SourceUnavailable: 已有新业绩申报，但未能定位业绩公告附件'}
        self.assertEqual(reason_text(row), '已有新业绩申报，但未能定位业绩公告附件')
        self.assertEqual(reason_text({'status': 'unavailable', 'reason': 'DATA_UNAVAILABLE: '}),
                         '没有取得可核验数据，具体原因未返回')

    def test_unconfigured_optional_alpha_is_skipped_not_reported_as_a_gap(self):
        class Client:
            def json(self, *args, **kwargs):
                raise AssertionError('Alpha must not be requested without a key')
            def get(self, *args, **kwargs):
                raise SourceUnavailable('feed offline')
        source = SecSources('TEST', CUTOFF, SecFixture())
        news = NewsSources('TEST', CUTOFF, Client(), source)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop('ALPHA_VANTAGE_API_KEY', None)
            with patch('news_data.company_articles', return_value=[]):
                result = news.company('2026-10-22')
            policy = news.global_news()
        self.assertEqual(result.quality, 'verified')
        self.assertNotIn('ALPHA_VANTAGE', result.reason)
        self.assertNotIn('ALPHA_VANTAGE', policy.reason)

    def test_foreign_private_issuer_is_rejected_before_any_research(self):
        from sec_sources import UnsupportedIssuer
        class Client(SecFixture):
            def json(self, url, **kwargs):
                body, receipt = super().json(url, **kwargs)
                if 'submissions' in url:
                    body['filings']['recent']['form'] = ['6-K', '4', '20-F']
                return body, receipt
        with self.assertRaisesRegex(UnsupportedIssuer, '20-F/6-K'):
            SecSources('TEST', CUTOFF, Client()).check_issuer()
        SecSources('TEST', CUTOFF, SecFixture()).check_issuer()

    def test_chat_brief_keeps_metrics_and_sources_but_not_raw_statements(self):
        source = SecSources('TEST', CUTOFF, SecFixture())
        full = source.financials().text
        brief = source.provenance() + source.gap_note() + source.book.report(statements=False)
        self.assertIn('已核验财务指标', brief)
        self.assertIn('不得称为最新季度数据', brief)
        self.assertIn('来源：[SEC 业绩公告]', brief)
        self.assertNotIn('income_statement:', brief)
        self.assertNotIn('127.6 billion', brief)
        self.assertIn('income_statement:', full)
        self.assertIn('127.6 billion', full)


class Response:
    status_code = 200
    def __init__(self, body):
        self.body = body
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def iter_content(self, size):
        yield json.dumps(self.body).encode()


class CacheTests(unittest.TestCase):
    def test_shared_cache_preserves_original_fetch_time_and_expires(self):
        calls, clock = [], [1000.]
        def request(url, **kwargs):
            calls.append(url)
            return Response({'value': len(calls)})
        with tempfile.TemporaryDirectory() as tmp, patch('public_data.time.sleep'):
            first = PublicClient(tmp, request, lambda: clock[0])
            value = first.get('https://data.sec.gov/test', ttl=10)
            second = PublicClient(tmp, request, lambda: clock[0])
            self.assertEqual(second.get('https://data.sec.gov/test', ttl=10), value)
            self.assertEqual(len(calls), 1)
            clock[0] += 11
            self.assertNotEqual(second.get('https://data.sec.gov/test', ttl=10)['fetchedAt'], value['fetchedAt'])
            self.assertEqual(len(calls), 2)
            self.assertTrue(all(p.stat().st_mode & 0o077 == 0 for p in Path(tmp).iterdir()))

    def test_free_alpha_budget_persists_between_jobs_and_does_not_store_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = PublicClient(tmp, clock=lambda: 1000.)
            for _ in range(25):
                client.reserve_alpha('private-key')
            with self.assertRaisesRegex(SourceUnavailable, '免费额度'):
                PublicClient(tmp, clock=lambda: 1000.).reserve_alpha('private-key')
            self.assertNotIn('private-key', ''.join(p.read_text() for p in Path(tmp).iterdir()))
            PublicClient(tmp, clock=lambda: 90000.).reserve_alpha('private-key')

    def test_disallowed_hosts_and_provider_error_payloads_are_not_cached(self):
        with tempfile.TemporaryDirectory() as tmp:
            client = PublicClient(tmp, request=lambda *a, **kw: Response({'Note': 'quota exceeded'}))
            with self.assertRaises(SourceUnavailable):
                client.get('http://127.0.0.1/private')
            with self.assertRaisesRegex(SourceUnavailable, '额度'):
                client.get('https://www.alphavantage.co/query', params={'apikey': 'fixture'}, alpha=True)
            self.assertFalse(any('quota exceeded' in p.read_text() for p in Path(tmp).iterdir()))


CUTOFF = datetime(2026, 10, 29, 8, tzinfo=timezone.utc)
PERIODIC = '0000000123-26-000001'
RELEASE = """<html><p>Company announces results for the quarter ended September 30, 2026.</p>
<p>Revenue increased to 127.6 billion USD. Diluted earnings per share were 2.12 USD.
The release contains GAAP results and separately labelled non-GAAP reconciliations.
Quarterly and year-to-date amounts must not be combined. The prior annual report is not the latest quarter.</p>
<table><tr><th>USD millions except per share</th><th>2025 quarter</th><th>2026 quarter</th></tr>
<tr><td>Revenue</td><td>100000</td><td>127600</td></tr></table></html>"""
FORM4 = """<ownershipDocument><issuer><issuerCik>123</issuerCik></issuer>
<reportingOwner><reportingOwnerId><rptOwnerName>Example</rptOwnerName></reportingOwnerId></reportingOwner>
<derivativeTable><derivativeTransaction><securityTitle><value>Class C Stock Units</value></securityTitle>
<transactionDate><value>2026-10-25</value></transactionDate><transactionCoding><transactionCode>F</transactionCode></transactionCoding>
<transactionAmounts><transactionShares><value>12</value></transactionShares><transactionPricePerShare><value>317.28</value></transactionPricePerShare>
<transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
</derivativeTransaction></derivativeTable><footnotes><footnote>Tax withholding.</footnote></footnotes></ownershipDocument>"""

def submissions():
    return {'cik': '0000000123', 'filings': {'recent': {
        'form': ['8-K', '4', '10-Q'],
        'accessionNumber': ['0000000123-26-000003', '0000000123-26-000002', PERIODIC],
        'filingDate': ['2026-10-28', '2026-10-27', '2026-07-23'],
        'acceptanceDateTime': ['2026-10-28T20:00:00Z', '2026-10-27T20:00:00Z', '2026-07-23T20:00:00Z'],
        'reportDate': ['2026-10-28', '2026-10-25', '2026-06-30'],
        'primaryDocument': ['q3.htm', 'xslF345X06/ownership.xml', 'q2.htm'],
        'items': ['2.02,9.01', '', '']}}}

def financial_facts():
    def fact(value, start='2026-04-01', end='2026-06-30'):
        return {'val': value, 'start': start, 'end': end, 'filed': '2026-07-23', 'accn': PERIODIC, 'form': '10-Q'}
    return {'cik': 123, 'facts': {'us-gaap': {
        'Revenues': {'units': {'USD': [fact(1000)]}},
        'NetIncomeLoss': {'units': {'USD': [fact(100)]}},
        'NetCashProvidedByUsedInOperatingActivities': {'units': {'USD': [fact(200, '2026-01-01')]}},
        'EarningsPerShareDiluted': {'units': {'USD/shares': [fact(1.5)]}}}}}


class NewsTests(unittest.TestCase):
    def test_fred_keeps_observation_date_unit_and_vintage_separate(self):
        from tradingagents.dataflows.vendors import fred
        with tempfile.TemporaryDirectory() as tmp, patch.dict(os.environ, {'FRED_API_KEY': 'fixture'}):
            runtime = DataRuntime('TEST', '2026-10-29', tmp)
            def response(url, **kwargs):
                self.assertEqual(kwargs['params']['api_key'], 'fixture')
                self.assertEqual(kwargs['ttl'], 0)
                data = {'observations': [{'date': '2026-09-01', 'value': '315'}]} if url.endswith('observations') \
                    else {'seriess': [{'units': 'Index 1982-1984=100'}]}
                return data, {'fetchedAt': CUTOFF.isoformat()}
            runtime.client.json = response
            try:
                runtime.install()
                args = {'series_id': 'CPIAUCSL', 'realtime_start': '2026-10-29'}
                fred._request('series', args)
                fred._request('series/observations', args)
                row = runtime.macro_records['CPIAUCSL']
                self.assertEqual(row['period'], '2026-09-01')
                self.assertEqual(row['revision'], '2026-10-29')
                self.assertEqual(row['unit'], 'Index 1982-1984=100')
            finally:
                runtime.close()

    def test_social_sources_do_not_get_a_score_from_news_alone(self):
        import tradingagents.graph.setup as setup
        with tempfile.TemporaryDirectory() as tmp:
            runtime = DataRuntime('TEST', '2026-10-29', tmp)
            runtime.prefetched = {'news': 'Verified earnings announcement'}
            try:
                runtime.install_analysts(setup)
                result = setup.create_sentiment_analyst(None)({'company_of_interest': 'TEST', 'trade_date': '2026-10-29'})
                self.assertIn('Unknown', result['sentiment_report'])
                self.assertIn('不能补成市场共识', result['sentiment_report'])
            finally:
                runtime.close()

    def test_partial_source_does_not_become_verified_just_because_it_has_text(self):
        with tempfile.TemporaryDirectory() as tmp:
            runtime = DataRuntime('TEST', '2026-10-29', tmp)
            runtime.invoke('example', [], lambda: SourceResult('A plausible headline', [self.article()],
                           quality='partial', reason='正文缺失'), 'news')
            self.assertEqual(runtime.coverage['news']['status'], 'unavailable')
            saved = json.loads(Path(tmp, 'source-evidence.json').read_text())
            self.assertIn('cutoff', saved)
            self.assertEqual(saved['records'][0]['contentLevel'], 'headline')

    def article(self, text='', level='headline'):
        return record('Fixture', 'https://publisher.test/story', CUTOFF.isoformat(),
                      '2026-10-28T18:00:00Z', content_level=level, title='Company earnings', text=text)

    def test_headlines_are_saved_as_leads_but_not_sent_as_verified_facts(self):
        result = render_news([self.article()])
        self.assertEqual(result.quality, 'unavailable')
        self.assertEqual(len(result.records), 1)
        self.assertNotIn('Company earnings', result.text)

    def test_summary_and_original_body_are_distinguished_and_deduplicated(self):
        row = self.article('Reported facts.', 'summary')
        result = render_news([row, row])
        self.assertEqual(result.quality, 'verified')
        self.assertIn('供应商摘要（非全文）', result.text)
        self.assertEqual(len(result.records), 1)

    def test_news_input_has_cutoff_ticker_and_body_checks(self):
        class Client:
            def json(self, *args, **kwargs):
                base = {'url': 'https://publisher.test/a', 'title': 'Earnings', 'summary': 'Facts',
                        'ticker_sentiment': [{'ticker': 'TEST'}], 'time_published': '20261029T070000'}
                return {'feed': [base, {**base, 'time_published': '20261029T090000'},
                                 {**base, 'ticker_sentiment': [{'ticker': 'OTHER'}]}]}, {'fetchedAt': CUTOFF.isoformat()}
        news = NewsSources('TEST', CUTOFF, Client(), None)
        with patch.dict(os.environ, {'ALPHA_VANTAGE_API_KEY': 'fixture'}):
            self.assertEqual(len(news.alpha(CUTOFF.replace(hour=0))), 1)


if __name__ == '__main__':
    unittest.main()
