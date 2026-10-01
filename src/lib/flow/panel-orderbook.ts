import {acquireOrderBook,type OrderBookIdentity,type SharedBookSnapshot,type SharedOrderBookLease} from './orderbook-hub';

export interface PanelOrderBookDemand extends OrderBookIdentity {
  active:boolean;running:boolean;view:string;sourceView:string;historical:boolean;chartPaused?:boolean;tickSize:number;
}
/** Lifecycle adapter for the original analysis panel. It owns a lease, not a
 * socket or order book, so hiding this panel cannot clear another consumer. */
export class PanelOrderBookSubscription {
  private lease?:SharedOrderBookLease;private off?:()=>void;private key='';private epoch=0;private dead=false;
  private current:SharedBookSnapshot|undefined;
  constructor(private onUpdate:(book:SharedBookSnapshot|undefined)=>void,private acquire:typeof acquireOrderBook=acquireOrderBook){}
  snapshot(){return this.current;}
  update(demand:PanelOrderBookDemand):void {
    if(this.dead)return;
    const key=`${demand.source}:${demand.marketType}:${demand.symbol}`;
    const supported=demand.source==='binance'&&demand.marketType==='usdm-perpetual';
    const visible=demand.active&&demand.view==='book'&&demand.sourceView==='live';
    const wanted=supported&&visible&&demand.running&&!demand.historical&&!demand.chartPaused&&Number.isFinite(demand.tickSize)&&demand.tickSize>0;
    if(!wanted){
      const previous=this.current,same=this.key===key;this.stop();this.key=key;
      this.publish(same&&previous&&visible&&(!demand.running||demand.chartPaused)?{...previous,status:'paused',bids:[],asks:[],warning:'盘口已暂停'}:undefined);
      return;
    }
    if(this.lease&&this.key===key)return;
    this.stop();this.key=key;this.publish(undefined);
    this.lease=this.acquire({source:demand.source,marketType:demand.marketType,symbol:demand.symbol});
    const epoch=this.epoch;
    this.off=this.lease.subscribe(book=>{if(!this.dead&&this.epoch===epoch)this.publish(book);});
  }
  reconnect(){return this.lease?.reconnect()??Promise.resolve();}
  destroy(){if(this.dead)return;this.dead=true;this.stop();this.current=undefined;}
  private stop(){this.epoch++;this.off?.();this.off=undefined;this.lease?.release();this.lease=undefined;}
  private publish(book:SharedBookSnapshot|undefined){this.current=book;this.onUpdate(book);}
}
