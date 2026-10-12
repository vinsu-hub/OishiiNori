// Run with: node services/api-fastapi/tests/bundle_fulfillment_sql.mjs /path/to/@electric-sql/pglite/dist/index.js
// Isolated PostgreSQL WASM, never connects to Supabase. The fixture represents
// the existing tables; the actual production migration is executed unchanged.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const { PGlite } = await import(pathToFileURL(process.argv[2]).href);
const db = new PGlite();
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
await db.exec(`
  create role anon; create role authenticated; create role service_role;
  create table profiles(id uuid primary key);
  create table products(id uuid primary key, name text, category text, active boolean default true, is_bundle boolean default false);
  create table product_sizes(id uuid primary key, product_id uuid references products, size_label text);
  create table transactions(id uuid primary key, status text default 'closed');
  create table transaction_items(id uuid primary key, transaction_id uuid references transactions, product_size_id uuid references product_sizes, quantity numeric);
  create table bundle_components(product_size_id uuid primary key references product_sizes, total_pieces integer);
  create table ingredients(id uuid primary key, name text, base_unit text, current_stock numeric(12,4), updated_at timestamptz, unit_cost numeric);
  create table recipe_items(id uuid primary key default gen_random_uuid(), product_size_id uuid references product_sizes, ingredient_id uuid references ingredients, qty_per_serving numeric(12,4), unit text, prep_notes text, unique(product_size_id,ingredient_id));
  create table bundle_fulfillments(id uuid primary key default gen_random_uuid(), transaction_item_id uuid references transaction_items, maki_roll_product_id uuid references products, quantity integer check(quantity>0), fulfilled_by uuid references profiles);
  create table inventory_movements(id uuid primary key default gen_random_uuid(), ingredient_id uuid references ingredients, type text, quantity numeric check(quantity>0), reason text, employee_id uuid references profiles);
`);
await db.exec(await readFile(new URL('../../../supabase/migrations/0063_atomic_bundle_fulfillment.sql', import.meta.url), 'utf8'));
await db.exec(await readFile(new URL('../../../supabase/migrations/0066_pending_bundle_deductions.sql', import.meta.url), 'utf8'));
await db.exec(`
  insert into profiles values ('${id(1)}');
  insert into products values ('${id(2)}','Large Platter','Platters',true,true),('${id(3)}','Torikatsu Maki','Oishii Maki Rolls',true,false),('${id(4)}','Futo Maki','Oishii Maki Rolls',true,false);
  insert into product_sizes values ('${id(5)}','${id(2)}','64 pcs'),('${id(6)}','${id(3)}','8 pcs'),('${id(7)}','${id(3)}','4 pcs'),('${id(8)}','${id(4)}','6 pcs');
  insert into transactions(id) values ('${id(9)}');
  insert into transaction_items values ('${id(10)}','${id(9)}','${id(5)}',1);
  insert into bundle_components values ('${id(5)}',64);
  insert into ingredients values ('${id(11)}','Rice','g',10000,now(),2),('${id(12)}','Nori','sheet',100,now(),10);
  insert into recipe_items values ('${id(13)}','${id(6)}','${id(11)}',220,'g'),('${id(14)}','${id(6)}','${id(12)}',1,'sheet'),('${id(15)}','${id(8)}','${id(11)}',180,'g');
  insert into bundle_recipe_sources values ('${id(3)}','${id(6)}',8),('${id(4)}','${id(8)}',6);
`);
const line = (product, quantity) => ({ maki_roll_product_id: id(product), quantity });
const fulfill = async (lines = [line(3, 64)]) => (await db.query('select fulfill_bundle_atomic($1,$2,$3,$4) as result', [id(9),id(10),id(1),JSON.stringify(lines)])).rows[0].result;
const fulfillPending = async (lines = [line(3, 64)]) => (await db.query('select fulfill_bundle_with_pending_atomic($1,$2,$3,$4) as result', [id(9),id(10),id(1),JSON.stringify(lines)])).rows[0].result;
const reconcile = async () => (await db.query('select reconcile_pending_bundle_atomic($1,$2) as result',[id(10),id(1)])).rows[0].result;
const publish = async (rows) => (await db.query('select publish_bundle_recipe_atomic($1,$2) as result',[id(6),JSON.stringify(rows)])).rows[0].result;
const restore = async () => (await db.query('select restore_bundle_atomic($1,$2,$3) as result',[id(9),id(10),id(1)])).rows[0].result;
const stock = async (n=11) => Number((await db.query('select current_stock from ingredients where id=$1',[id(n)])).rows[0].current_stock);
const count = async (table) => Number((await db.query(`select count(*) from ${table}`)).rows[0].count);
let passed=0;
async function test(name, fn) {
  await db.exec('begin');
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  finally { await db.exec('rollback'); }
}
async function rejected(fn, code) {
  await db.exec('savepoint expected_failure');
  await assert.rejects(fn, (e) => e.code === code);
  await db.exec('rollback to savepoint expected_failure');
}
await test('Two-size flavor: 64 pieces deduct eight 8-piece servings, not 64', async () => {
  const response=await fulfill();
  assert.equal(response.total_pieces,64);
  assert.equal(await stock(),8240);
  assert.equal(await stock(12),92);
  assert.equal(Number((await db.query('select recipe_servings from bundle_fulfillments')).rows[0].recipe_servings),8);
});
await test('Mixed flavors use each confirmed piece yield', async () => {
  await fulfill([line(3,16),line(4,48)]);
  assert.equal(await stock(),8120);
  assert.equal(await stock(12),98);
});
await test('Multiple platters require multiplied piece total', async () => {
  await db.exec(`update transaction_items set quantity=2`);
  await rejected(()=>fulfill(),'PT400');
  await fulfill([line(3,128)]);
  assert.equal(await stock(),6480);
});
await test('Identical retry returns original response without deducting again', async () => {
  const a=await fulfill();
  const b=await fulfill([line(3,32),line(3,32)]);
  assert.deepEqual(a,b); assert.equal(await stock(),8240);
  assert.equal(await count('bundle_fulfillment_batches'),1);
  assert.equal(await count('inventory_movements'),2);
});
await test('Conflicting retry refuses a different selection', async () => {
  await fulfill(); await rejected(()=>fulfill([line(4,64)]),'PT409');
  assert.equal(await stock(),8240);
});
await test('Later flavor missing configuration leaves no earlier deduction', async () => {
  await db.exec(`delete from bundle_recipe_sources where product_id='${id(4)}'`);
  await rejected(()=>fulfill([line(3,16),line(4,48)]),'PT400');
  assert.equal(await stock(),10000); assert.equal(await count('bundle_fulfillments'),0);
});
await test('Recipe-free size cannot silently fulfill with zero stock usage', async () => {
  await db.exec(`update bundle_recipe_sources set product_size_id='${id(7)}' where product_id='${id(3)}'`);
  await rejected(()=>fulfill(),'PT400'); assert.equal(await stock(),10000);
});
await test('A mapping to another product size is refused', async () => {
  await db.exec(`update bundle_recipe_sources set product_size_id='${id(8)}' where product_id='${id(3)}'`);
  await rejected(()=>fulfill(),'PT400');
});
await test('Wrong total, fractional, zero and negative piece counts are refused', async () => {
  for (const lines of [[line(3,63)],[line(3,63.5),line(4,.5)],[line(3,64),line(4,0)],[line(3,65),line(4,-1)],[]]) {
    await rejected(()=>fulfill(lines),'PT400');
  }
  assert.equal(await count('inventory_movements'),0);
});
await test('Legacy partial rows block retry rather than marking success', async () => {
  await db.exec(`insert into bundle_fulfillments(transaction_item_id,maki_roll_product_id,quantity,fulfilled_by) values ('${id(10)}','${id(3)}',16,'${id(1)}')`);
  await rejected(()=>fulfill(),'PT409'); assert.equal(await stock(),10000);
});
await test('Injected failure after stock write rolls back stock, rows and movements', async () => {
  await db.exec(`create function fail_movement() returns trigger language plpgsql as $$ begin raise exception 'injected failure'; end; $$;
    create trigger fail_movement before insert on inventory_movements for each row execute function fail_movement();`);
  await rejected(()=>fulfill(),'P0001');
  assert.equal(await stock(),10000);
  for (const table of ['bundle_fulfillments','bundle_fulfillment_batches','bundle_ingredient_deductions','inventory_movements']) assert.equal(await count(table),0);
});
await test('Reversal uses saved deductions after recipe changes and is retry-safe', async () => {
  await fulfill();
  await db.exec(`update recipe_items set qty_per_serving=999`);
  assert.equal(await restore(),true); assert.equal(await stock(),10000); assert.equal(await stock(12),100);
  assert.equal(await restore(),true); assert.equal(await stock(),10000);
  assert.equal(await count('inventory_movements'),4);
  await rejected(()=>fulfill(),'PT409');
});
await test('Reversal write failure leaves deduction and batch intact', async () => {
  await fulfill();
  await db.exec(`create function fail_reversal() returns trigger language plpgsql as $$ begin raise exception 'injected reversal failure'; end; $$;
    create trigger fail_reversal before insert on inventory_movements for each row execute function fail_reversal();`);
  await rejected(()=>restore(),'P0001'); assert.equal(await stock(),8240);
  assert.equal((await db.query('select restored_at from bundle_fulfillment_batches')).rows[0].restored_at,null);
});
await test('Voided transactions cannot be fulfilled', async () => {
  await db.exec(`update transactions set status='voided'`); await rejected(()=>fulfill(),'PT409');
});
await test('Refund seals an unfulfilled item against a late kitchen submission', async () => {
  assert.equal(await restore(),true);
  await rejected(()=>fulfill(),'PT409');
  assert.equal(await stock(),10000);
});
await test('Piece fractions use stock precision and reverse exactly', async () => {
  await fulfill([line(3,63),line(4,1)]);
  await restore(); assert.equal(await stock(),10000); assert.equal(await stock(12),100);
});
await test('Unit mismatch fails rather than guessing a conversion', async () => {
  await db.exec(`update recipe_items set unit='kg' where ingredient_id='${id(11)}'`);
  await rejected(()=>fulfill(),'PT400');
});
await test('Premium flavors are refused for classic Sushi Boat', async () => {
  await db.exec(`update products set name='Sushi Boat' where id='${id(2)}'; update products set name='Dragon Maki' where id='${id(3)}'`);
  await rejected(()=>fulfill(),'PT400');
});
await test('Anonymous and authenticated browser roles cannot execute stock RPCs', async () => {
  for (const role of ['anon','authenticated']) {
    const permissions=await db.query(`select has_function_privilege($1,'fulfill_bundle_atomic(uuid,uuid,uuid,jsonb)','execute') as allowed`,[role]);
    assert.equal(permissions.rows[0].allowed,false);
    const pending=await db.query(`select has_function_privilege($1,'fulfill_bundle_with_pending_atomic(uuid,uuid,uuid,jsonb)','execute') as allowed`,[role]);
    assert.equal(pending.rows[0].allowed,false);
  }
});
await test('Unit mismatch logs exact rolls but no stock or movements', async () => {
  await db.exec(`update recipe_items set unit='pcs' where id='${id(13)}'`);
  const first=await fulfillPending();
  assert.equal(first.stock_deduction_status,'pending_recipe');
  assert.deepEqual(first.ingredients_deducted,[]);
  assert.equal(await stock(),10000);
  assert.equal(await count('bundle_pending_deductions'),1);
  assert.equal(await count('inventory_movements'),0);
  assert.deepEqual(await fulfillPending(),first);
  assert.equal(await count('bundle_fulfillments'),1);
});
await test('A later invalid roll still rejects the entire pending selection', async () => {
  await db.exec(`update recipe_items set unit='pcs' where id='${id(13)}'; delete from bundle_recipe_sources where product_id='${id(4)}'`);
  await rejected(()=>fulfillPending([line(3,16),line(4,48)]),'PT400');
  assert.equal(await count('bundle_fulfillment_batches'),0);
  assert.equal(await count('bundle_pending_deductions'),0);
  assert.equal(await stock(),10000);
});
await test('Corrected recipe deducts once with a reversal snapshot', async () => {
  await db.exec(`update recipe_items set unit='pcs' where id='${id(13)}'`);
  await fulfillPending();
  const rows=[{ingredient_id:id(11),qty_per_serving:220,unit:'g',prep_notes:null},{ingredient_id:id(12),qty_per_serving:1,unit:'sheet',prep_notes:null}];
  assert.equal(await publish(rows),2);
  assert.equal(await reconcile(),true);
  assert.equal(await stock(),8240);
  assert.equal(await count('bundle_ingredient_deductions'),2);
  assert.equal(await reconcile(),false);
  assert.equal(await stock(),8240);
  assert.equal((await fulfillPending()).stock_deduction_status,'applied');
  await restore();
  assert.equal(await stock(),10000);
});
await test('Refund before correction seals pending rolls without stock movement', async () => {
  await db.exec(`update recipe_items set unit='pcs' where id='${id(13)}'`);
  await fulfillPending();
  await restore();
  await db.exec(`update recipe_items set unit='g' where id='${id(13)}'`);
  assert.equal(await reconcile(),false);
  assert.equal(await stock(),10000);
  assert.equal(await count('inventory_movements'),0);
});
await test('Publishing rejects mismatched units before changing saved recipe', async () => {
  await rejected(()=>publish([{ingredient_id:id(11),qty_per_serving:220,unit:'pcs'}]),'PT400');
  assert.equal(await count('recipe_items'),3);
});
console.log(`${passed} SQL integration checks passed. No production connection used.`);
await db.close();
