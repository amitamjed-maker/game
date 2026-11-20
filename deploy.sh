#!/usr/bin/env bash
# ব্যবহার: bash deploy.sh https://TOKEN@github.com/USER/REPO.git "মেসেজ"
set -e
REPO="$1"
MSG="${2:-update}"
if [ -z "$REPO" ]; then
  echo "রিপোর লিংক দিন: bash deploy.sh https://TOKEN@github.com/USER/REPO.git"
  exit 1
fi
[ -d .git ] || git init -q
git config user.email >/dev/null 2>&1 || git config user.email "game@local"
git config user.name  >/dev/null 2>&1 || git config user.name "Tamjed"
git checkout -B main
git add -A
git commit -m "$MSG" || echo "নতুন কোনো পরিবর্তন নেই"
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO"
git push -u origin main
echo "✅ push হয়েছে। GitHub > Actions ট্যাবে বিল্ড দেখুন।"
