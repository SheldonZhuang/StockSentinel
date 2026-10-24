@echo off
rem Moomoo paper trading runner for hypotheses 19/20 (SIMULATE only).
rem Scheduled daily at 22:00 and 23:00 Beijing time. The script itself only trades between
rem 09:40-15:50 US Eastern on US trading days, and at most once per day, so both DST and
rem standard time are covered without duplicate orders. Keep this file ASCII-only: cmd reads .bat as GBK.
cd /d D:\sheldonproject\StockSentinel\backend
"C:\Python313\python.exe" -I backtest\lab\moomoo_paper.py run --submit >> backtest\lab\out\moomoo_paper.log 2>&1
