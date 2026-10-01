/** Small numeric helpers shared by the curved and banded Huzi structures. */
export interface PriceColumns {open:Float64Array;high:Float64Array;low:Float64Array;close:Float64Array}

export interface Quadratic {
  /** y = a·(x − origin)² + b·(x − origin) + c */
  a:number;b:number;c:number;origin:number;
  at:(x:number)=>number;
  /** Slope dy/dx at x. */
  slopeAt:(x:number)=>number;
  /** Coefficient of determination over the fitted points (1 = exact). */
  r2:number;
}

/** Least-squares parabola. x is centred on its mean so long, high-index series stay well conditioned. */
export function fitQuadratic(xs:readonly number[],ys:readonly number[]):Quadratic|undefined {
  const n=xs.length;
  if(n<3||ys.length!==n)return;
  let mx=0;for(const x of xs)mx+=x;mx/=n;
  // Normal equations for [1, u, u²] with u = x − mean.
  let s1=n,su=0,su2=0,su3=0,su4=0,sy=0,suy=0,su2y=0;
  for(let i=0;i<n;i++){
    const u=xs[i]-mx,y=ys[i],u2=u*u;
    su+=u;su2+=u2;su3+=u2*u;su4+=u2*u2;sy+=y;suy+=u*y;su2y+=u2*y;
  }
  const m=[[s1,su,su2,sy],[su,su2,su3,suy],[su2,su3,su4,su2y]];
  for(let col=0;col<3;col++){
    let pivot=col;for(let r=col+1;r<3;r++)if(Math.abs(m[r][col])>Math.abs(m[pivot][col]))pivot=r;
    if(Math.abs(m[pivot][col])<1e-12)return;
    [m[col],m[pivot]]=[m[pivot],m[col]];
    for(let r=col+1;r<3;r++){const f=m[r][col]/m[col][col];for(let k=col;k<4;k++)m[r][k]-=f*m[col][k];}
  }
  const coef=[0,0,0];
  for(let r=2;r>=0;r--){let v=m[r][3];for(let k=r+1;k<3;k++)v-=m[r][k]*coef[k];coef[r]=v/m[r][r];}
  const [c,b,a]=coef;
  const at=(x:number)=>a*(x-mx)**2+b*(x-mx)+c;
  let mean=0;for(const y of ys)mean+=y;mean/=n;
  let ssTotal=0,ssResidual=0;
  for(let i=0;i<n;i++){ssTotal+=(ys[i]-mean)**2;ssResidual+=(ys[i]-at(xs[i]))**2;}
  return {a,b,c,origin:mx,at,slopeAt:x=>2*a*(x-mx)+b,r2:ssTotal>0?1-ssResidual/ssTotal:0};
}
