"""Offline API/report regression tests. Run: python -m unittest discover -s tests."""
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError

from app.auth import CurrentUser, get_current_user
from app.bundles import atomic_bundles_available, completed_bundle_ids, legacy_recipe_sizes
from app.routers import transactions, pnl, menu_admin


class Query:
    def __init__(self, db, table):
        self.db, self.name, self.filters = db, table, []

    def select(self, *_): return self
    def order(self, *_, **__): return self
    def range(self, start, end):
        self.start, self.end = start, end
        return self
    def limit(self, *_): return self
    def gte(self, *_): return self
    def lte(self, *_): return self
    def neq(self, *_): return self
    def eq(self, key, value):
        self.filters.append(lambda r: r.get(key) == value)
        return self
    def in_(self, key, values):
        self.filters.append(lambda r: r.get(key) in values)
        return self
    def is_(self, key, value):
        self.filters.append(lambda r: r.get(key) is None if value == 'null' else r.get(key) is not None)
        return self
    def execute(self):
        rows = [r for r in self.db.rows.get(self.name, []) if all(f(r) for f in self.filters)]
        return SimpleNamespace(data=rows[getattr(self, 'start', 0):getattr(self, 'end', len(rows) - 1) + 1])


class FakeDB:
    def __init__(self, **rows): self.rows = rows
    def table(self, name): return Query(self, name)


USER = CurrentUser('employee', 'executive', 'kitchen', 'Test', [])


class BundleTests(unittest.TestCase):
    def test_completion_requires_whole_legacy_bundle(self):
        db = FakeDB(bundle_fulfillments=[{'transaction_item_id': 'partial', 'quantity': 16}, {'transaction_item_id': 'full', 'quantity': 64}],
                    transaction_items=[{'id': iid, 'quantity': 1, 'product_sizes': {'bundle_components': {'total_pieces': 64}}} for iid in ['partial','full']])
        self.assertEqual(completed_bundle_ids(db, ['partial','full']), {'full'})

    def test_restored_batch_is_not_completed_even_if_lines_remain(self):
        db = FakeDB(bundle_fulfillment_batches=[{'transaction_item_id':'item','restored_at':'now'}],
                    bundle_fulfillments=[{'transaction_item_id':'item','quantity':64}])
        self.assertEqual(completed_bundle_ids(db, ['item']), set())

    def test_ambiguous_legacy_reversal_refuses_all_sizes(self):
        db = FakeDB(product_sizes=[{'id':'eight','product_id':'roll'},{'id':'four','product_id':'roll'}])
        with self.assertRaises(HTTPException) as ctx:
            legacy_recipe_sizes(db,[{'maki_roll_product_id':'roll'}])
        self.assertEqual(ctx.exception.status_code,409)

    def test_absent_migration_degrades_but_network_errors_do_not(self):
        db = MagicMock()
        db.table.return_value.select.return_value.limit.return_value.execute.side_effect = APIError({'code':'PGRST205','message':'table absent','details':'','hint':''})
        self.assertFalse(atomic_bundles_available(db))
        db.table.return_value.select.return_value.limit.return_value.execute.side_effect = RuntimeError('network')
        with self.assertRaises(RuntimeError): atomic_bundles_available(db)

    def client(self):
        app = FastAPI()
        app.include_router(transactions.router)
        app.include_router(menu_admin.router)
        app.dependency_overrides[get_current_user] = lambda: USER
        return TestClient(app)

    def test_existing_tablet_request_contract_calls_atomic_rpc(self):
        db = MagicMock()
        result = {'transaction_item_id':'item','total_pieces':64,'lines':[{'maki_roll_product_id':'roll','quantity':64}],'ingredients_deducted':[]}
        db.rpc.return_value.execute.return_value.data = result
        with patch.object(transactions,'get_supabase',return_value=db):
            response = self.client().post('/transactions/tx/items/item/bundle-fulfillment',json={'lines':result['lines']})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(), {**result, 'stock_deduction_status': 'applied'})
        db.rpc.assert_called_once_with('fulfill_bundle_atomic', {'p_transaction_id':'tx','p_item_id':'item','p_employee_id':'employee','p_lines':result['lines']})
        db.table.assert_not_called()  # no Python-side incremental deductions

    def test_opt_in_tablet_request_calls_pending_rpc(self):
        db = MagicMock()
        lines = [{'maki_roll_product_id': 'roll', 'quantity': 32}]
        db.rpc.return_value.execute.return_value.data = {
            'transaction_item_id': 'item', 'total_pieces': 32, 'lines': lines,
            'ingredients_deducted': [], 'stock_deduction_status': 'pending_recipe',
        }
        with patch.object(transactions, 'get_supabase', return_value=db):
            response = self.client().post('/transactions/tx/items/item/bundle-fulfillment',
                                          json={'lines': lines, 'allow_pending_recipe': True})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['stock_deduction_status'], 'pending_recipe')
        db.rpc.assert_called_once_with('fulfill_bundle_with_pending_atomic', {
            'p_transaction_id': 'tx', 'p_item_id': 'item', 'p_employee_id': 'employee', 'p_lines': lines,
        })

    def test_expected_database_errors_are_actionable_http_errors(self):
        for code,status in [('PT400',400),('PT409',409),('PT404',404),('PGRST202',503)]:
            db=MagicMock()
            db.rpc.return_value.execute.side_effect=APIError({'code':code,'message':'Recipe needs review','details':'','hint':''})
            with patch.object(transactions,'get_supabase',return_value=db):
                response=self.client().post('/transactions/tx/items/item/bundle-fulfillment',json={'lines':[{'maki_roll_product_id':'roll','quantity':64}]})
            self.assertEqual(response.status_code,status)

    def test_mapping_rejects_size_from_another_product(self):
        db=FakeDB(products=[{'id':'roll','category':'Oishii Maki Rolls','is_bundle':False}],product_sizes=[{'id':'size','product_id':'another'}])
        with patch.object(menu_admin,'get_supabase',return_value=db):
            response=self.client().put('/products/roll/bundle-recipe',json={'product_size_id':'size','pieces_per_serving':8})
        self.assertEqual(response.status_code,400)

    def test_mapping_does_not_allow_an_empty_recipe(self):
        db=FakeDB(products=[{'id':'roll','category':'Oishii Maki Rolls','is_bundle':False}],product_sizes=[{'id':'size','product_id':'roll'}])
        with patch.object(menu_admin,'get_supabase',return_value=db):
            response=self.client().put('/products/roll/bundle-recipe',json={'product_size_id':'size','pieces_per_serving':8})
        self.assertEqual(response.status_code,400)

    def report_db(self):
        return FakeDB(transactions=[{'id':'tx','total_amount':1000,'discount_amount':0,'tax_amount':0}],
                      transaction_items=[{'id':'item','transaction_id':'tx','quantity':1,'unit_price':1000,'product_size_id':'platter','product_sizes':{'product_id':'bundle','products':{'department':'kitchen','is_bundle':True},'bundle_components':{'total_pieces':64}}}],
                      bundle_fulfillments=[{'transaction_item_id':'item','maki_roll_product_id':'roll','quantity':64}],
                      ingredients=[{'id':'rice','unit_cost':2}])

    def report(self,db):
        with patch.object(pnl,'get_supabase',return_value=db), patch.object(pnl,'_bundle_fulfillments_supported_check',return_value=True), patch.object(pnl,'_compute_payroll_summary',return_value={'total_pay':0,'employee_count':0}):
            return pnl.get_pnl('today',USER)

    def test_pnl_uses_snapshot_quantities_not_current_recipe_size(self):
        db=self.report_db()
        db.rows['bundle_fulfillment_batches']=[{'transaction_item_id':'item','restored_at':None}]
        db.rows['bundle_ingredient_deductions']=[{'transaction_item_id':'item','quantity':1760,'ingredients':{'unit_cost':2}}]
        db.rows['product_sizes']=[{'id':'eight','product_id':'roll'},{'id':'four','product_id':'roll'}]
        report=self.report(db)
        self.assertEqual(report.costs.cogs,3520)
        self.assertEqual(report.unresolved_bundle_costs,0)

    def test_pnl_flags_pending_batch_without_guessing_cost(self):
        db = self.report_db()
        db.rows['bundle_fulfillment_batches'] = [{'transaction_item_id': 'item', 'restored_at': None}]
        db.rows['bundle_pending_deductions'] = [
            {'transaction_item_id': 'item', 'resolved_at': None},
        ]
        report = self.report(db)
        self.assertEqual(report.costs.cogs, 0)
        self.assertEqual(report.unresolved_bundle_costs, 1)

    def test_pnl_flags_ambiguous_legacy_size_instead_of_selecting_last(self):
        db=self.report_db()
        db.rows['product_sizes']=[{'id':'eight','product_id':'roll'},{'id':'four','product_id':'roll'}]
        report=self.report(db)
        self.assertEqual(report.costs.cogs,0)
        self.assertEqual(report.unresolved_bundle_costs,1)

    def test_pnl_ignores_reversed_snapshot(self):
        db=self.report_db()
        db.rows['bundle_fulfillment_batches']=[{'transaction_item_id':'item','restored_at':'now'}]
        db.rows['bundle_ingredient_deductions']=[{'transaction_item_id':'item','quantity':1760,'ingredients':{'unit_cost':2}}]
        self.assertEqual(self.report(db).costs.cogs,0)


if __name__ == '__main__': unittest.main()
