# M4-05: Demo Video Script & Shot List (PREP)

**Target length:** 60-120 seconds  
**Devnet only** — production recording waits on Friday's settlement event.

## Pre-recording Checklist

**Security (operator-rules §5: no secrets on screen):**
- [ ] Browser: no visible `.env` files, keypair files, or API keys in editor/terminal
- [ ] Environment variables hidden (no `printenv`, `echo $ANTHROPIC_API_KEY`, etc.)
- [ ] Safe to show on screen: devnet program ID, devnet market addresses, devnet transaction signatures, devnet wallet addresses (throwaway funded from faucet)
- [ ] NOT safe to show: `ANTHROPIC_API_KEY`, `TIINGO_API_KEY`, `TWELVEDATA_API_KEY`, `SERVICE_TOKEN`, admin keypair path/content, automation keypair

**Dependencies:**
- All MRs merged to main (final app/automation/quant/ops-agent state)
- Markets created for Friday's date with realistic strikes
- Market-maker running (fair value + two-sided quotes visible)
- Settlement event Friday ~16:05 ET (close + 5 min delay)
- At least one settlement failure → ops-agent incident → draft (for clip #9)

## Storyboard (9 Required Elements)

### Shot 1: Wallet Connect (0:00-0:08, ~8s) ⏳ PENDING !83
**Page:** `/` (landing)  
**Actions:**
1. Click "Connect Wallet" button
2. Select "Try the demo" burner wallet from adapter modal (#51)
3. Auto-connects and auto-funds from faucet (no popup needed)

**Overlay/Narration:** "One-click devnet demo: the burner wallet connects and funds instantly."

**Dependencies:** 
- Demo burner wallet (!83 M4-07) ⏳
- App deployed ✅

---

### Shot 2: Faucet (0:08-0:18, ~10s) ⏳ PENDING !83
**Page:** `/` (auto-funded via burner wallet)  
**Actions:**
1. Show banner confirming burner wallet connection
2. Show USDC balance appearing (auto-funded from faucet)
3. Optional: show alternate wallet can click manual faucet button

**Overlay/Narration:** "The burner wallet auto-funds from the devnet faucet. Manual faucet available for other wallets."

**Dependencies:** 
- Demo burner wallet auto-fund (!83 M4-07) ⏳
- App `/api/faucet` route working ✅
- Devnet USDC mint deployed ✅

---

### Shot 3: Buy NO (0:18-0:35, ~17s) ⏳ PENDING !49
**Page:** `/trade` (or market detail page)  
**Actions:**
1. Navigate to a market (e.g., META Friday $680 strike)
2. Click "Buy NO" or select NO side
3. Enter quantity (e.g., 50 contracts)
4. Enter limit price (e.g., 35¢ for YES price of 65¢)
5. Click "Place Order" or "Buy"
6. Approve transaction in wallet
7. Show order confirmation

**Overlay/Narration:** "Buy NO at 35¢ means you're betting YES stays under your price. Instant on-chain matching."

**Dependencies:**
- Trade page (!49 M2-06) ⏳
- Markets created and Open
- Book has existing orders (or market-maker providing liquidity)

---

### Shot 4: YES/NO Book (0:35-0:48, ~13s) ⏳ PENDING !49
**Page:** `/trade` or market detail with visible order book  
**Actions:**
1. Show the book panel (bids/asks for YES and NO)
2. Hover or highlight a few price levels
3. Show your order appearing in the book (if resting) or matched (if filled)

**Overlay/Narration:** "The on-chain CLOB shows all resting bids and asks. Trade against other users or the market maker."

**Dependencies:**
- Trade page (!49 M2-06) ⏳
- Book has multiple price levels (market-maker running)
- UI renders book from on-chain `Book` account

---

### Shot 5: Fair Value + Market Maker (0:48-1:00, ~12s) ⏳ PENDING !49
**Page:** Market detail or `/trade` with fair value indicator  
**Actions:**
1. Point to fair value display (e.g., "Fair: 64¢" for YES)
2. Show market-maker orders updating (bids/asks around fair value)
3. Optionally show `/api/market-data` or quant service if exposed

**Overlay/Narration:** "Fair value from Black-Scholes; the market maker quotes around it, tightening spreads."

**Dependencies:**
- Trade page (!49 M2-06) ⏳
- Quant service running (`GET /fair-values`) ✅
- Market-maker loop active (pending)
- UI displays fair value (from `/api/market-data`) ✅

---

### Shot 6: Friday Settlement (1:00-1:15, ~15s) ⏳ PENDING !49
**Page:** `/trade` or `/` (watch for settlement event)  
**Actions:**
1. Show market status changing from "Open" to "Settling" to "Settled"
2. Show settlement price appearing (e.g., "Settled: YES 68.42¢" from oracle)
3. Show outcome badge (YES/NO winner)

**Overlay/Narration:** "Friday 16:05 ET: Pyth oracle posts the official close, verified on-chain. RedStone as fallback. Market settles, outcome locked."

**Dependencies:**
- Trade page (!49 M2-06) ⏳
- **Friday settlement event** (automation runs `settle_market` at close + 5 min) ✅
- Pyth as primary live price source (#49) ⏳
- RedStone as fallback oracle (D-054) ✅
- At least one market settles successfully via oracle (not override)

---

### Shot 7: Redeem (1:15-1:25, ~10s) ⏳ PENDING !43
**Page:** Portfolio or market detail with "Redeem" button  
**Actions:**
1. Click "Settle Funds" (if needed, separate step)
2. Click "Redeem"
3. Approve transaction
4. Show USDC balance increase (e.g., +$68.42 for 100 YES contracts settled at 68.42¢)

**Overlay/Narration:** "Redeem your winners for USDC. Instant, on-chain."

**Dependencies:**
- Portfolio page (!43 M2-07) ⏳
- Market settled (from shot #6)
- User holds YES or NO tokens in a settled market

---

### Shot 8: /status Page (1:25-1:35, ~10s) ✅ READY
**Page:** `/status`  
**Actions:**
1. Scroll through Config section (pause state, oracle settings)
2. Scroll through Markets table (show a few settled and open markets)
3. Highlight invariant checks (vault balance = pairs outstanding × $1)
4. Show "All checks passed" or any warnings

**Overlay/Narration:** "The status page shows every on-chain invariant and the program's health. Transparency first."

**Dependencies:**
- `/status` page deployed (M3-04) ✅
- Multiple markets exist (mix of Open/Settled)
- No invariant violations (or show a test violation if safe)

---

### Shot 9: Ops-Agent Clip (1:35-2:00, ~25s) ✅ READY
**Page:** Admin section (or show ops-agent draft JSON/UI)  
**Actions:**
1. Show an incident that triggered ops-agent (settlement failure due to spread)
2. Show the draft generated by ops-agent (incident note, proposed price, sources)
3. Show admin approving the draft (or just the draft in "pending_approval" state)
4. Optionally show the `admin_settle_override` transaction if override actually runs

**Overlay/Narration:** "When oracles disagree, the ops agent investigates with Claude, drafts an override. The admin reviews and approves after a delay."

**Dependencies:**
- **At least one settlement failure → ops-agent incident** (requires injected oracle fault or real oracle spread > 5 bps)
- M3-05 (ops-agent service) deployed and wired to app ✅
- M3-06 (admin override UI) merged ✅
- Ops-agent has generated at least one draft in "pending_approval" status (demo-ops script M3-07) ✅
- If showing override execution: override delay (1 hour default) must have passed OR use a test Config with short delay

---

## Notes

**Video file hosting (differs from AC):**  
The ticket's AC may list "commit video to repo," but **operator-rules §5 forbids committing binaries or large files** (they exhaust GitLab storage/bandwidth, block CI). The final video must be uploaded to an external host (Loom, YouTube unlisted, Vimeo, or Paawan's choice) and **linked in the MR/docs**, not committed to git.

**Tier 2 question for Paawan (MR description only):**  
If the AC explicitly requires the video file in the repo, this conflicts with operator §5. Proposed resolution: amend the AC to "link to video" instead of "commit video file." This question goes in the MR description for Paawan to decide; it does NOT go in `docs/status.md` Open questions.

**Recording timing:**  
Shot #6 (Friday settlement) and shot #9 (ops-agent clip, if showing live override) both require real Friday events. The demo script and shot list are ready now (this prep MR); the actual recording happens Friday or after.
