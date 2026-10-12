// Offline ticket tests: TS text commands + canvas raster + Python bridge parity.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { build } from '../../../apps/dashboard-web/node_modules/esbuild/lib/main.js';
const result=await build({ entryPoints:['apps/dashboard-web/client/src/lib/kitchenTicket.ts'], bundle:true,write:false,format:'esm',platform:'node' });
const ticket=await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
const index=new Map([['size',{name:'Katsudon Curry (Chicken)',sizeLabel:'1 plate'}]]);
const cases=[['dine_in',2,'DINE IN'],['dine_in',null,'DINE IN'],['takeout',null,'TAKE OUT'],['delivery',null,'DELIVERY'],[null,null,'CHECK ORDER TYPE'],['unknown',null,'CHECK ORDER TYPE']];
for (const [order_type,table_number,label] of cases) {
  const order={ id:'sample',order_number:123,order_type,table_number,opened_at:'2026-10-08T04:00:00Z',items:[{product_size_id:'size',quantity:1}] };
  const header=ticket.buildTicketHeader(order).map(s=>s.trim());
  assert.equal(header[0],'ORDER #123'); assert.equal(header[1],label);
  if(table_number) assert.equal(header[2],`TABLE ${table_number}`);
  assert.ok(Buffer.from(ticket.kitchenTicketTextCommands(order,index)).includes(Buffer.from(label)));
  const python=execFileSync('python3',['-c',`import sys,json; sys.path.insert(0,'kitchen-print-bridge'); from ticket import build_ticket_header; print(json.dumps(build_ticket_header(json.loads(sys.argv[1]),32)))`,JSON.stringify(order)],{encoding:'utf8'});
  assert.deepEqual(ticket.buildTicketHeader(order),JSON.parse(python));
  const drawn=[];
  const ctx={ measureText:(text)=>({width:text.length*18}),fillRect(){},fillText(text){drawn.push(text)},getImageData(_x,_y,w,h){return {data:new Uint8ClampedArray(w*h*4).fill(255)}} };
  globalThis.document={createElement:()=>({width:0,height:0,getContext:()=>ctx})};
  assert.ok(ticket.kitchenTicketRaster(order,index).length>0);
  assert.ok(drawn.includes(label),`Raster missing ${label}`);
  if(table_number) assert.ok(drawn.includes(`TABLE ${table_number}`));
  delete globalThis.document;
  console.log(`PASS ${order_type ?? 'missing'}: text, ESC/POS, raster and Python bridge`);
}
