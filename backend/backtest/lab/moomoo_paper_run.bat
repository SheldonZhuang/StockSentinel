@echo off
rem Moomoo 模拟盘每日执行（假设 19 / 20）。计划任务每天北京时间 22:00 和 23:00 各触发一次：
rem 脚本只在美东 9:40-15:50 且为美股交易日时下单，同一天只执行一次，所以冬令时/夏令时都能命中且不会重复。
cd /d D:\sheldonproject\StockSentinel\backend
"C:\Python313\python.exe" -I backtest\lab\moomoo_paper.py run --submit >> backtest\lab\out\moomoo_paper.log 2>&1
