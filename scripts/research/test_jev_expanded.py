import unittest
from jev_follow_eval import payload_for
from jev_follow_backtest import replay
from jev_expanded_eval import pooled_metrics
import test_jev_follow as fixtures


class ExpandedTests(unittest.TestCase):
    def test_period_only_changes_declared_timeframe_and_execution_unit(self):
        case={'signal':{'index':12,'side':'long'},'previous_signal':{'index':2,'side':'short'},'segment':[[0,100,102,99,101,10,100,100]],'features':{}}
        old=payload_for(case);new=payload_for({**case,'interval':'5m','period_ms':300000})
        self.assertEqual(new['questions'],old['questions'])
        self.assertEqual(new['state']['timeframe'],'5m');self.assertIn('5-minute',new['state']['execution']['entry'])
        self.assertEqual(new['state']['segment'],old['state']['segment'])
    def test_five_minute_terminal_mark_uses_correct_bar_close(self):
        market,cases=fixtures.FollowTests().market()
        for b in market['bars']:b[0]*=5
        market['period_ms']=300000;market['marks']={str(b[0]):b[4] for b in market['bars']};market['signals']=market['signals'][:1]
        result=replay(cases[:1],{'TEST':market},{'2':True})
        self.assertEqual(result['trades'][0]['exit_time'],market['bars'][-1][0]+299999)
    def test_pooled_results_do_not_invent_a_single_account_drawdown(self):
        market,cases=fixtures.FollowTests().market()
        one=replay(cases,{'TEST':market},{'2':True});two=replay(cases,{'TEST':market},{'6':True})
        pooled=pooled_metrics([one,two])
        self.assertAlmostEqual(pooled['total_net_pnl'],one['metrics']['total_net_pnl']+two['metrics']['total_net_pnl'])
        self.assertEqual(pooled['trades'],one['metrics']['trades']+two['metrics']['trades'])
        self.assertNotIn('return_pct',pooled);self.assertNotIn('closed_trade_drawdown',pooled)


if __name__=='__main__':unittest.main()
