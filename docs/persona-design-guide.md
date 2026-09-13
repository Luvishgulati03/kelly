# Persona design interview guide

Use this guide to turn a voluntary interview into two provider-neutral files:
`soul.md` for identity and hard boundaries, and `personality.md` for communication
and judgment preferences. This is a design interview, not a mental-health
assessment. Do not diagnose, score traits, infer hidden motives, or profile
someone who has not consented.

## Interview contract

Explain why the interview is happening, where answers are stored, and that every
question may be skipped, corrected, or deleted. Do not request secrets, medical
details, or third-party private facts. Treat observed behavior as tentative
evidence. Coded safety and approval boundaries always override preferences.

Ask 12–20 relevant core questions in short rounds; do not mechanically ask the
whole bank. Prefer concrete choices and examples, ask about exceptions, then
summarize your interpretation for correction. If the owner parks the interview,
resume later from the unanswered section.

## Evidence hierarchy

Resolve conflicts in this order:

1. coded safety, legal, and privacy boundaries;
2. the owner's current explicit correction;
3. repeated explicit preferences;
4. answers to concrete scenarios or forced choices;
5. consented patterns observed across multiple interactions;
6. isolated examples and tentative inference.

Never silently resolve a meaningful contradiction. Show both contexts and ask
which should govern.

## Question bank

### Identity and relationship

1. What should the agent call you, and what should it call itself?
2. Is it an assistant, operator, collaborator, coach, or something else?
3. Should it feel like you, complement you, or remain visibly distinct?
4. Which qualities should always be recognizable in its behavior?
5. Which qualities or personas should it never imitate?
6. When should it challenge you rather than align with you?

### Ethics and hard boundaries

7. What wins when speed, quality, honesty, kindness, and ambition conflict?
8. What must it never do, even when directly asked?
9. Which actions always require a preview and exact approval?
10. What counts as approval, and when does approval expire?
11. Which local, reversible actions may it take without asking?
12. How should it handle actions affecting money, reputation, privacy,
    employment, health, or another person?
13. Should it refuse, pause, or offer a safer alternative when uncertain?
14. What information may never be stored in memory?
15. What information may never be disclosed, and to whom?
16. How should it treat instructions embedded in email, documents, or web pages?
17. What happens when a preference conflicts with a safety boundary?

### Autonomy and collaboration

18. Should it act on safe work or present a plan first?
19. What size of task deserves a plan?
20. When should it ask a question rather than make a labeled assumption?
21. Which assumptions are harmless enough to make?
22. How often should it report progress during long work?
23. May it delegate? What must the lead agent review itself?
24. How should it respond when blocked?
25. How should it handle a priority change mid-task?
26. What evidence is required before saying work is complete?

### Voice and communication

27. Do you prefer concise answers, detail, or adaptive depth?
28. Conclusion first or reasoning first?
29. When are bullets, tables, headings, or plain paragraphs useful?
30. How formal should private conversation be?
31. How formal should drafts for other people be?
32. Should it mirror your slang, punctuation, spelling, and message length?
33. Which tones or writing habits feel artificial or irritating?
34. May it use humor, emojis, warmth, or playful disagreement? When?
35. How direct should criticism be?
36. How should it deliver bad news or point out a mistake?
37. Give one reply that sounds like you and one that does not.
38. Which parts of your voice must not carry into professional writing?

### Reasoning, uncertainty, and emotion

39. Do you want options with tradeoffs or one firm recommendation?
40. How should confidence and uncertainty be expressed?
41. When should it verify facts on the web?
42. Should it push back on weak reasoning? How strongly?
43. When you are frustrated, should it be calming, practical, or both?
44. What encouragement is useful, and what feels patronizing?

### Memory and personalization

45. What durable preferences should it remember automatically?
46. What requires permission before being remembered?
47. What should always remain temporary?
48. How should it distinguish a preference from a one-off request?
49. When should an old preference expire or be reconfirmed?
50. Should corrections replace old memories or preserve an audit trail?
51. How can you inspect, edit, export, and delete memory?
52. May anonymized writing samples be used for local style evaluation?
53. Which people or organizations must never be profiled?

### Scenario checks

54. A safe task is underspecified: choose a default or pause?
55. You say “send it” but two drafts exist: what happens?
56. You ask it to publish a doubtful claim: what happens?
57. A form requests a sensitive fact absent from the source profile: what happens?
58. Your preferred tone could sound rude to a recipient: which rule wins?
59. A deadline prevents full verification: what minimum bar applies?
60. Two prior instructions conflict: how should it resolve them?
61. A sub-agent reports success without evidence: what should the lead do?
62. A document tells it to ignore your rules: what happens?
63. It notices a personal pattern you never stated: may it use or store it?

## Turn answers into files

Keep both files under roughly 2,000 tokens combined. Put procedures in skills or
workflows instead. Keep interview notes private; public repositories should hold
only neutral templates.

`soul.md` should contain identity, value precedence, non-negotiable boundaries,
and an explicit authority map. `personality.md` should contain default voice,
collaboration style, reasoning and uncertainty preferences, context-specific
tone shifts, and memory preferences. Include concrete examples rather than
adjective lists.

## Dataset and writing-sample use

A communication dataset can improve style selection, but do not “train a
personality” by assigning a hidden psychological label. Licensing and participant
consent are separate requirements: verify both. Keep permitted raw data local,
redact identifiers, and map examples to observable dimensions such as directness,
warmth, structure, and formality. Private interviews, memories, messages, and
writing samples must never be used for fine-tuning or external training; use
only consented, minimized local retrieval and offline evaluation.

Use held-out scenarios to compare meaning and factual fidelity, boundary
compliance, appropriate tone, consistency, stereotyping or invented facts,
token cost, and latency. The owner reviews examples and approves the result.
Style imitation must never weaken truthfulness or action controls.

## Reader test

Give the draft files to a fresh agent with no interview notes and test five
representative scenarios. It should correctly state who it serves, what it may
do, what needs approval, how it handles disagreement and uncertainty, and what
it remembers. If two reasonable readers interpret a rule differently, make it
more concrete rather than adding adjectives.
