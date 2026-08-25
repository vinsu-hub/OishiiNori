-- skip_stock_deduction was always a request-only flag on
-- CreateLossRecordRequest (create_loss_record uses it to decide whether to
-- deduct current_stock at write time) but was never persisted -- there was
-- no way to tell, after the fact, which historical losses had already been
-- accounted for by a stock count vs which ones actually reduced stock.
-- Station Items' computed Usage (0028) needs this distinction to sum only
-- the losses that really moved current_stock.

alter table loss_records add column skip_stock_deduction boolean not null default false;
