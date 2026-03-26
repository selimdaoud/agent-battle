pkill -f "node engine.js" 2>/dev/null; sleep 1
cd /Users/sdaoud/CODE/agent-battle-gpt/v2 && node engine.js > /tmp/engine.log 2>&1 &
echo "PID: $!"
sleep 5 && tail -15 /tmp/engine.log
