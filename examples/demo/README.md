# Fictional Kelly test catalogue

All brands, products and prices here are invented. The uniform 18% GST is a
test fixture, not tax advice or a statement of applicable product tax rates.
No customer contacts, real sales or supplier claims are included.

Seed from the Kelly repository: `node --import tsx scripts/seed-demo.ts`.
Then run `kelly start --demo` from any folder. Open the printed voice URL.
The demo uses port 7338 and `data/demo/`, separate from your normal Kelly data.
The local speech worker still needs the configured models and Python environment.

Try these requests, then check and correct the transcript before submitting:

- “DemoAster ke dus 9 watt LED bulbs aur do ceiling fans ka quotation banao.”
- “अब यही सामान DemoBirch में दिखाओ।”
- “Compare five office chairs and two office desks from both demo brands.”
- “Do fans chahiye.” Kelly should ask which brand/model, not guess.
- “Get me a solar inverter.” There is no inverter in this catalogue.

Ten DemoAster bulbs plus two fans: subtotal ₹5,000, test GST ₹900, total ₹5,900.
The same DemoBirch basket: subtotal ₹6,000, test GST ₹1,080, total ₹7,080.
Nothing is sent to a customer. Demo mode is for owner testing, not public access.
