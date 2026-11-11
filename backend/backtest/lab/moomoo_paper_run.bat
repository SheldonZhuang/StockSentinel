@echo off
rem Moomoo paper trading runner for hypotheses 19/20 (SIMULATE only).
rem Scheduled daily at 22:00, 23:00, 00:00 and 01:00 Beijing time (00:00/01:00 added 2026-11-11 so unfilled orders
rem get a same-day retry in winter, when 22:00 Beijing is 09:00 ET before the stock open). The script itself only trades between
rem 09:40-15:50 US Eastern on US trading days, and at most once per day, so both DST and
rem standard time are covered without duplicate orders. Keep this file ASCII-only: cmd reads .bat as GBK.
cd /d D:\sheldonproject\StockSentinel\backend
"C:\Python313\python.exe" -I backtest\lab\moomoo_paper.py run --submit >> backtest\lab\out\moomoo_paper.log 2>&1
