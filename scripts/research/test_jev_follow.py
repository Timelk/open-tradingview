import unittest
from jev_follow_backtest import replay,reference_trade

class FollowTests(unittest.TestCase):
    def market(self):
        bars=[[i*60000,100+i,102+i,99+i,101+i,100] for i in range(20)]
        signals=[{'index':2,'side':'long'},{'index':6,'side':'short'},{'index':7,'side':'short'},{'index':12,'side':'long'},{'index':17,'side':'short'}]
        m={'symbol':'TEST','bars':bars,'signals':signals,'funding':[],'marks':{str(b[0]):b[4] for b in bars},'contract':{'min_qty':.01,'step_size':.01,'max_qty':10000,'market_min':.01,'market_step':.01,'market_max':10000,'min_notional':5}}
        cases=[{'id':str(s['index']),'symbol':'TEST','signal':s} for s in signals[:4]]
        return m,cases
    def test_skipping_opposite_entry_still_closes_existing_position(self):
        m,c=self.market();r=replay(c,{'TEST':m},{'2':True})
        self.assertEqual(len(r['trades']),1);self.assertEqual(r['trades'][0]['entry_index'],4);self.assertEqual(r['trades'][0]['exit_index'],7)
    def test_same_direction_does_not_pyramid(self):
        m,c=self.market();r=replay(c,{'TEST':m},{x['id']:True for x in c})
        self.assertEqual(len(r['trades']),3);self.assertEqual([t['side'] for t in r['trades']],['long','short','long'])
    def test_short_entry_has_adverse_prices_and_short_funding_sign(self):
        m,c=self.market();m['funding']=[{'fundingTime':600000,'fundingRate':.001,'markPrice':110}]
        r=reference_trade(c[1],m);self.assertLess(r['entry_price'],108);self.assertGreater(r['exit_price'],113);self.assertLess(r['funding_cost'],0);self.assertLess(r['net_pnl'],0)
    def test_cancel_entry_on_reverse_before_delayed_fill(self):
        m,c=self.market();m['signals'].insert(1,{'index':3,'side':'short'})
        self.assertFalse(reference_trade(c[0],m)['valid']);r=replay(c,{'TEST':m},{'2':True});self.assertEqual(r['trades'],[])
    def test_read_future_exit_but_never_open_untested_future_signal(self):
        m,c=self.market();r=replay(c[:1],{'TEST':m},{'2':True})
        self.assertEqual(len(r['trades']),1);self.assertEqual(r['trades'][0]['exit_index'],7)
    def test_late_model_response_does_not_create_backdated_position(self):
        m,c=self.market();r=replay(c,{'TEST':m},{'2':True},late={'2'})
        self.assertEqual(r['trades'],[]);self.assertIn('late_response',[a['event'] for a in r['actions']])
    def test_terminal_mark_is_not_fabricated_closed_trade(self):
        m,c=self.market();m['signals']=m['signals'][:1];r=replay(c[:1],{'TEST':m},{'2':True})
        self.assertEqual(r['metrics']['trades'],0);self.assertEqual(r['metrics']['open_positions'],1);self.assertEqual(r['trades'][0]['status'],'open')

if __name__=='__main__':unittest.main()
