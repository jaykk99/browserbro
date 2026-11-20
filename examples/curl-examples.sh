#!/bin/bash
# browserbro curl examples. Start the server first: npm start
BASE="${BASE:-http://localhost:3101}"

echo "== health =="
curl -s "$BASE/api/health"; echo

echo "== create session =="
SID=$(curl -s -X POST "$BASE/api/sessions" -H 'Content-Type: application/json' -d '{"name":"example"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).session.id))")
echo "session: $SID"

echo "== navigate to Hacker News =="
curl -s -X POST "$BASE/api/sessions/$SID/navigate" -H 'Content-Type: application/json' -d '{"url":"https://news.ycombinator.com"}'; echo

echo "== title =="
curl -s "$BASE/api/sessions/$SID/title"; echo

echo "== links (first 3) =="
curl -s "$BASE/api/sessions/$SID/links" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d).links.slice(0,3),null,2)))"

echo "== screenshot =="
curl -s "$BASE/api/sessions/$SID/screenshot" -o hn.png && ls -l hn.png

echo "== search (free, keyless) =="
curl -s -X POST "$BASE/api/search" -H 'Content-Type: application/json' -d '{"query":"playwright"}' | head -c 600; echo

echo "== fetch (free, keyless) =="
curl -s -X POST "$BASE/api/fetch" -H 'Content-Type: application/json' -d '{"url":"https://example.com"}'; echo

echo "== delete session =="
curl -s -X DELETE "$BASE/api/sessions/$SID"; echo
