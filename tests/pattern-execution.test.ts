import {describe,it,expect} from 'vitest';
// @ts-expect-error Research .mjs is deliberately independent of application TypeScript.
import {simulateTrade} from '../scripts/research/pattern-execution.mjs';

const step=60_000;
function rows(values:number[][]){return values.map(([open,high,low,close],i)=>[i*step,open,high,low,close,100]);}
const signal=(extra:Record<string,unknown>={})=>({id:'test',entryIndex:1,direction:'bullish',stop:90,t1:110,t2:120,...extra});
const free={feeBps:0,slippageBps:0,intervalMs:step};

describe('pattern research execution',()=>{
  it('charges actual fill notionals and both adverse slippages against raw-entry notional',()=>{
    const result=simulateTrade(rows([[100,101,99,100],[100,111,99,110]]),signal(),{intervalMs:step});
    const entry=100*1.0001,exit=110*.9999;
    expect(result.entryPrice).toBe(entry);expect(result.exitPrice).toBe(exit);
    expect(result.gross).toBeCloseTo(.1,12);
    expect(result.fees).toBeCloseTo((entry+exit)/100*.0005,12);
    expect(result.slippageCost).toBeCloseTo(((entry-100)+(110-exit))/100,12);
    expect(result.net).toBeCloseTo((exit-entry)/100-result.fees,12);
    expect(result.rMultiple).toBeCloseTo(result.net/((entry-90)/100),12);
    expect(result.equityPath.at(-1).netReturn).toBeCloseTo(result.net,12);
  });

  it.each(['bullish','bearish'])('gives stops precedence on an ambiguous %s target/stop bar',direction=>{
    const result=simulateTrade(rows([[100,100,100,100],[100,112,88,100]]),
      signal({direction,stop:direction==='bullish'?90:110,t1:direction==='bullish'?110:90}),free);
    expect(result.net).toBeCloseTo(-.1,12);expect(result.ambiguous).toBe(true);
    expect(result.reason).toBe('both-hit-stop-first');
  });

  it('fills a gapped stop at adverse open and a gapped target at its conservative limit',()=>{
    const prefix=[[100,100,100,100],[100,102,98,100]];
    const stopped=simulateTrade(rows([...prefix,[80,82,79,81]]),signal(),free);
    const won=simulateTrade(rows([...prefix,[115,117,114,116]]),signal(),free);
    expect(stopped.exitPrice).toBe(80);expect(stopped.net).toBeCloseTo(-.2);expect(stopped.reason).toBe('gap-stop');
    expect(won.exitPrice).toBe(110);expect(won.net).toBeCloseTo(.1);expect(won.reason).toBe('gap-t1');
    expect(won.exitTime).toBe(2*step);
  });

  it('rejects a next-open entry beyond the target or the initial stop',()=>{
    const bars=rows([[100,100,100,100],[115,116,114,115]]);
    expect(simulateTrade(bars,signal(),free)).toMatchObject({excluded:true,reason:'target-already-crossed',net:null});
    expect(simulateTrade(bars,signal({stop:116,t1:130}),free)).toMatchObject({excluded:true,reason:'invalid-initial-risk'});
    expect(simulateTrade(bars,signal({entryIndex:2}),free)).toMatchObject({excluded:true,reason:'missing-entry-bar'});
  });

  it('takes half at T1, preserves original stop that bar, and activates break-even next bar',()=>{
    const result=simulateTrade(rows([[100,100,100,100],[100,112,95,105],[106,108,99,101]]),signal(),{...free,exitMode:'split'});
    expect(result.exitParts.map((p:any)=>[p.index,p.rawPrice,p.fraction])).toEqual([[1,110,.5],[2,100,.5]]);
    expect(result.reason).toBe('break-even');expect(result.net).toBeCloseTo(.05);
    expect(result.equityPath[0]).toMatchObject({remainingFraction:.5});
    expect(result.equityPath[0].netReturn).toBeCloseTo(.075);
  });

  it('executes both targets when no original risk is touched and defers break-even even on an open-gap T1',()=>{
    const both=simulateTrade(rows([[100,100,100,100],[100,121,95,118]]),signal(),{...free,exitMode:'split'});
    expect(both.net).toBeCloseTo(.15);expect(both.exitParts).toHaveLength(2);expect(both.reason).toBe('t2');
    const gap=simulateTrade(rows([[100,100,100,100],[100,103,99,101],[112,115,95,106],[106,109,99,101]]),signal(),{...free,exitMode:'split'});
    expect(gap.exitParts.map((p:any)=>p.index)).toEqual([2,3]);expect(gap.net).toBeCloseTo(.05);
  });

  it('short split trade mirrors long execution and short funding direction',()=>{
    const result=simulateTrade(rows([[100,100,100,100],[100,103,89,95],[95,99,79,82]]),
      signal({direction:'bearish',stop:110,t1:90,t2:80}),{...free,exitMode:'split',funding:[{fundingTime:step+1000,fundingRate:.01,markPrice:100}]});
    expect(result.gross).toBeCloseTo(.15);expect(result.fundingCost).toBeCloseTo(-.005);
    // T1's possible intrabar exit cannot receive an optimistic funding credit.
    expect(result.net).toBeCloseTo(.155);expect(result.fundingAmbiguousCount).toBe(1);
  });

  it('funds only the remaining half after T1 and excludes entry-time and post-exit events',()=>{
    const result=simulateTrade(rows([[100,100,100,100],[100,112,99,109],[109,115,105,111],[111,121,108,120]]),signal(),{
      ...free,exitMode:'split',funding:[
        {fundingTime:step,fundingRate:1,markPrice:100},
        {fundingTime:2*step+1000,fundingRate:.01,markPrice:110},
        {fundingTime:4*step,fundingRate:1,markPrice:100},
      ]});
    expect(result.fundingCost).toBeCloseTo(.0055);expect(result.net).toBeCloseTo(.1445);
    expect(result.fundingLedger).toHaveLength(1);expect(result.fundingAmbiguousCount).toBe(0);
    expect(result.equityPath[1].fundingCost).toBeCloseTo(.0055);
    expect(result.equityPath.at(-1).netReturn).toBeCloseTo(result.net);
  });

  it('conserves the entire ledger through split fills and multiple positive/negative settlements',()=>{
    const result=simulateTrade(rows([[100,100,100,100],[100,105,96,104],[104,112,102,109],[109,114,106,111],[111,121,108,118]]),signal(),{
      intervalMs:step,exitMode:'split',feeBps:7,slippageBps:3,funding:[
        {fundingTime:step+1000,fundingRate:.001,markPrice:101},
        {fundingTime:2*step+1000,fundingRate:.002,markPrice:108},
        {fundingTime:3*step+1000,fundingRate:-.001,markPrice:111},
        {fundingTime:4*step+1000,fundingRate:.003,markPrice:119},
      ]});
    // Full position first; conservative full debit in ambiguous T1 bar; half thereafter.
    const funding=.01*101*.001+.01*108*.002-.005*111*.001+.005*119*.003;
    expect(result.fundingCost).toBeCloseTo(funding,14);
    expect(result.exitParts.reduce((total:number,part:any)=>total+part.fraction,0)).toBe(1);
    expect(result.netReturn).toBeCloseTo(result.gross-result.fees-result.slippageCost-result.fundingCost,14);
    const final=result.equityPath.at(-1);
    expect(final.remainingFraction).toBe(0);expect(final.unrealizedGross).toBe(0);
    expect(final.netReturn).toBeCloseTo(result.netReturn,14);
    expect(final.fees).toBeCloseTo(result.fees,14);expect(final.fundingCost).toBeCloseTo(funding,14);
    expect(final.slippageCost).toBeCloseTo(result.slippageCost,14);
  });

  it('charges adverse funding on uncertain exit bars but omits favorable funding credits',()=>{
    const data=rows([[100,100,100,100],[100,112,98,109]]),event={fundingTime:step+1000,fundingRate:.01,markPrice:100};
    const paid=simulateTrade(data,signal(),{...free,funding:[event]});
    const credit=simulateTrade(data,signal(),{...free,funding:[{...event,fundingRate:-.01}]});
    expect(paid.fundingCost).toBeCloseTo(.01);expect(credit.fundingCost).toBe(0);
    expect(paid.fundingAmbiguousCount).toBe(1);expect(credit.fundingAmbiguousCount).toBe(1);
  });

  it('includes mark-to-close drawdowns, realized halves, and all costs in equityPath',()=>{
    const result=simulateTrade(rows([[100,100,100,100],[100,105,91,92],[92,111,91,110]]),signal(),{intervalMs:step});
    expect(result.equityPath[0].netReturn).toBeLessThan(-.08);
    expect(result.equityPath[0].fees).toBeCloseTo(.00050005,12);
    expect(result.equityPath[0].slippageCost).toBeCloseTo(.0001,12);
    expect(result.equityPath.at(-1).netReturn).toBeCloseTo(result.net,12);
  });

  it('forces explicit loss exits at purge and data-end boundaries instead of discarding them',()=>{
    const data=rows([[100,100,100,100],[100,105,92,94],[94,98,91,93],[93,111,92,109]]);
    const purge=simulateTrade(data,signal(),{...free,endIndex:2});
    const tail=simulateTrade(data.slice(0,2),signal(),free);
    expect(purge).toMatchObject({excluded:false,truncated:true,forcedExit:true,reason:'end-index',exitIndex:2});
    expect(purge.net).toBeCloseTo(-.07);expect(tail).toMatchObject({reason:'data-end',truncated:true});
    expect(tail.net).toBeCloseTo(-.06);
    expect(simulateTrade(data,signal(),{...free,endIndex:0})).toMatchObject({excluded:true,reason:'end-before-entry'});
  });

  it('honors max holding bars, object bars and explicit intervalMs',()=>{
    const data=rows([[100,100,100,100],[100,105,95,102],[102,105,98,103]]).map(r=>({time:r[0],open:r[1],high:r[2],low:r[3],close:r[4],volume:r[5]}));
    const result=simulateTrade(data,signal(),{...free,maxHoldBars:1});
    expect(result).toMatchObject({reason:'max-hold',exitIndex:1,holdingBars:1,truncated:false});
    expect(result.net).toBeCloseTo(.02);
  });

  it('exposes missing-data truncation and rejects duplicate funding rather than double-charging',()=>{
    const data=rows([[100,100,100,100],[100,105,95,98],[98,105,97,100]]);data[2][0]+=step;
    const result=simulateTrade(data,signal(),free);
    expect(result).toMatchObject({reason:'future-data-gap',truncated:true,exitIndex:1});expect(result.net).toBeCloseTo(-.02);
    const event={fundingTime:step+1,fundingRate:.001,markPrice:100};
    expect(()=>simulateTrade(data,signal(),{...free,funding:[event,event]})).toThrow(/Funding/);
  });
});
