Drop photo/video files in this folder, then reference them by filename in `data/gallery.json`.

Photo entry:

```json
{ "type": "photo", "title": "Conference talk — SysConf 2025", "image": "conference-talk.jpg" }
```

Video entry (poster is optional — a thumbnail frame shown before playback):

```json
{ "type": "video", "title": "Lab walkthrough", "video": "lab-walkthrough.mp4", "poster": "lab-walkthrough-poster.jpg" }
```

Paths are relative to this folder. If `image`/`video`/`poster` is omitted or the file isn't here yet, that tile falls back to a generated color placeholder (using the entry's `title` and `color` fields) so nothing breaks while you're still adding media.
