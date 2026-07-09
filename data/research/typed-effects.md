A small experimental language, **Esker**, tracks side effects in its type system so that data races become *compile-time* errors instead of postmortem incident reports.

- Esker programs compile to plain Go, no runtime required
- An early case study cut a recurring class of race conditions to zero over six months
- Code: [github.com/yourhandle/esker](https://github.com/yourhandle/esker)
