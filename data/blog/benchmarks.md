Three weeks ago I had a result that looked too good to share: a **40% latency improvement** from a one-line change. It turned out our benchmark harness was reusing a warmed-up cache between runs.

The fix was trivial. The lesson wasn't: any number that arrives without a fight deserves a second look before it goes in a paper.

I've since added a "does this feel too easy" checklist to my own review process. So far it has caught two more bugs and one genuinely good result.
