(function(){
  "use strict";

  /* ---------------------------------------------------
     Tiny placeholder-image generator (inline SVG data URI).
     Used for gallery thumbnails/lightbox — replace any of
     these with real photos/videos by editing data/gallery.json.
  --------------------------------------------------- */
  function ph(label, color, w, h){
    w = w || 480; h = h || 320;
    var safe = String(label).replace(/&/g,'&amp;').replace(/</g,'&lt;');
    var svg = "<svg xmlns='http://www.w3.org/2000/svg' width='" + w + "' height='" + h + "'>" +
      "<rect width='100%' height='100%' fill='#" + color + "'/>" +
      "<text x='50%' y='50%' font-family='monospace' font-size='16' fill='#ffffff' " +
      "text-anchor='middle' dominant-baseline='middle'>" + safe + "</text></svg>";
    return "data:image/svg+xml," + encodeURIComponent(svg);
  }

  /* ---------------------------------------------------
     Minimal markdown renderer — headings, bold/italic,
     links, images, inline code, and bullet lists.
     Enough to let any panel below "support rich markdown
     format" (the brief's words) without an external library.
  --------------------------------------------------- */
  function inline(text){
    text = text.replace(/!\[([^\]]*)\]\(((?:[^()]|\([^()]*\))*)\)/g, '<img src="$2" alt="$1" loading="lazy">');
    text = text.replace(/\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    return text;
  }

  function renderMarkdown(md){
    var lines = md.trim().split('\n');
    var html = '', para = [], inList = false;

    function flushPara(){
      if (para.length){ html += '<p>' + inline(para.join(' ')) + '</p>'; para = []; }
    }

    lines.forEach(function(raw){
      var line = raw.trim();
      if (line === ''){
        flushPara();
        if (inList){ html += '</ul>'; inList = false; }
        return;
      }
      var h = line.match(/^(#{1,4})\s+(.*)/);
      if (h){
        flushPara();
        if (inList){ html += '</ul>'; inList = false; }
        var level = Math.min(h[1].length + 1, 4);
        html += '<h' + level + '>' + inline(h[2]) + '</h' + level + '>';
        return;
      }
      var li = line.match(/^[-*]\s+(.*)/);
      if (li){
        flushPara();
        if (!inList){ html += '<ul>'; inList = true; }
        html += '<li>' + inline(li[1]) + '</li>';
        return;
      }
      para.push(line);
    });
    flushPara();
    if (inList) html += '</ul>';
    return html;
  }

  /* ---------------------------------------------------
     Tabs
  --------------------------------------------------- */
  var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  var panels = {
    about: document.getElementById('panel-about'),
    research: document.getElementById('panel-research'),
    gallery: document.getElementById('panel-gallery'),
    blog: document.getElementById('panel-blog')
  };

  function selectTab(name){
    tabButtons.forEach(function(btn){
      var match = btn.dataset.tab === name;
      btn.setAttribute('aria-selected', match ? 'true' : 'false');
      btn.tabIndex = match ? 0 : -1;
    });
    Object.keys(panels).forEach(function(key){
      panels[key].hidden = key !== name;
    });
  }

  tabButtons.forEach(function(btn, i){
    btn.addEventListener('click', function(){ selectTab(btn.dataset.tab); });
    btn.addEventListener('keydown', function(e){
      var dir = (e.key === 'ArrowRight') ? 1 : (e.key === 'ArrowLeft') ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      var next = tabButtons[(i + dir + tabButtons.length) % tabButtons.length];
      next.focus();
      selectTab(next.dataset.tab);
    });
  });
  selectTab('about');

  /* ---------------------------------------------------
     Header — fetched from partials/header.html
  --------------------------------------------------- */
  fetch('partials/header.html')
    .then(function(r){ return r.text(); })
    .then(function(html){ document.getElementById('header-mount').innerHTML = html; })
    .catch(function(err){ console.error('Failed to load header:', err); });

  /* ---------------------------------------------------
     About — fetched from data/about.md
  --------------------------------------------------- */
  fetch('data/about.md')
    .then(function(r){ return r.text(); })
    .then(function(md){ panels.about.innerHTML = renderMarkdown(md); })
    .catch(function(err){ console.error('Failed to load about content:', err); });

  /* ---------------------------------------------------
     Research — accordion, one dropdown per project.
     Data fetched from data/research.json.
  --------------------------------------------------- */
  function renderResearch(projects){
    var researchHtml = '<p class="panel-intro">Selected ongoing and completed projects. Select a title to expand details.</p>';
    projects.forEach(function(p, i){
      researchHtml +=
        '<div class="project">' +
          '<button class="project-toggle" aria-expanded="false" aria-controls="project-body-' + i + '">' +
            '<span><span class="project-title">' + p.title + '</span>' +
            '<span class="project-meta">' + p.status + ' · ' + p.period + '</span></span>' +
            '<span class="project-indicator" aria-hidden="true">+</span>' +
          '</button>' +
          '<div class="project-body" id="project-body-' + i + '" hidden></div>' +
        '</div>';
    });
    panels.research.innerHTML = researchHtml;

    panels.research.querySelectorAll('.project-toggle').forEach(function(btn, i){
      btn.addEventListener('click', function(){
        var body = document.getElementById('project-body-' + i);
        var open = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', open ? 'false' : 'true');
        btn.querySelector('.project-indicator').textContent = open ? '+' : '–';
        body.hidden = open;
        if (!open && !body.dataset.rendered){
          body.innerHTML = '<p class="panel-intro">Loading…</p>';
          fetch('data/' + projects[i].file)
            .then(function(r){ return r.text(); })
            .then(function(md){ body.innerHTML = renderMarkdown(md); })
            .catch(function(err){ console.error('Failed to load project content:', err); });
          body.dataset.rendered = '1';
        }
      });
    });
  }

  fetch('data/research.json')
    .then(function(r){ return r.json(); })
    .then(renderResearch)
    .catch(function(err){ console.error('Failed to load research content:', err); });

  /* ---------------------------------------------------
     Gallery — tiled grid, opens lightbox on click
     (photos enlarge, videos play). Data fetched from
     data/gallery.json; media files live in images/gallery/
     (see images/gallery/README.md).
  --------------------------------------------------- */
  var galleryItems = [];

  function mediaPath(rel){ return 'images/' + rel; }

  function galleryThumbSrc(item){
    if (item.type === 'video') return item.poster ? mediaPath(item.poster) : ph(item.title, item.color, 400, 400);
    return item.image ? mediaPath(item.image) : ph(item.title, item.color, 400, 400);
  }

  function renderGallery(items){
    galleryItems = items;
    var galleryHtml = '<p class="panel-intro">A tiling of photos and videos — select any tile to enlarge or play it.</p><div class="gallery-grid">';
    items.forEach(function(item, i){
      galleryHtml +=
        '<button class="gallery-item" data-index="' + i + '" aria-label="Open ' + item.title + '">' +
          '<img src="' + galleryThumbSrc(item) + '" alt="' + item.title + '" loading="lazy">' +
          '<span class="gallery-badge">' + item.type + '</span>' +
          '<span class="gallery-caption">' + item.title + '</span>' +
        '</button>';
    });
    galleryHtml += '</div>';
    panels.gallery.innerHTML = galleryHtml;

    panels.gallery.querySelectorAll('.gallery-item').forEach(function(btn){
      var item = galleryItems[Number(btn.dataset.index)];
      var img = btn.querySelector('img');
      // Falls back to the placeholder tile if the referenced file isn't in images/gallery/ yet.
      img.addEventListener('error', function(){ img.src = ph(item.title, item.color, 400, 400); }, { once: true });
      btn.addEventListener('click', function(){ openLightbox(item); });
    });
  }

  fetch('data/gallery.json')
    .then(function(r){ return r.json(); })
    .then(renderGallery)
    .catch(function(err){ console.error('Failed to load gallery content:', err); });

  var lightbox = document.getElementById('lightbox');
  var lightboxMedia = document.getElementById('lightbox-media');
  var lightboxCaption = document.getElementById('lightbox-caption');
  var lightboxClose = document.getElementById('lightbox-close');
  var lastFocused = null;

  function openLightbox(item){
    lastFocused = document.activeElement;
    if (item.type === 'video'){
      var video = document.createElement('video');
      video.controls = true;
      video.autoplay = true;
      video.poster = item.poster ? mediaPath(item.poster) : ph(item.title, item.color, 800, 450);
      if (item.video){
        var source = document.createElement('source');
        source.src = mediaPath(item.video);
        video.appendChild(source);
      }
      lightboxMedia.innerHTML = '';
      lightboxMedia.appendChild(video);
      lightboxCaption.innerHTML = item.title + (item.video ? '' :
        '<br><span class="lightbox-note">Drop a video file in images/gallery/ and reference it via this item\'s "video" field in data/gallery.json to enable playback.</span>');
    } else {
      var img = document.createElement('img');
      img.alt = item.title;
      img.src = item.image ? mediaPath(item.image) : ph(item.title, item.color, 900, 560);
      img.addEventListener('error', function(){ img.src = ph(item.title, item.color, 900, 560); }, { once: true });
      lightboxMedia.innerHTML = '';
      lightboxMedia.appendChild(img);
      lightboxCaption.textContent = item.title;
    }
    lightbox.hidden = false;
    lightboxClose.focus();
  }

  function closeLightbox(){
    lightbox.hidden = true;
    lightboxMedia.innerHTML = '';
    if (lastFocused) lastFocused.focus();
  }

  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function(e){ if (e.target === lightbox) closeLightbox(); });
  document.addEventListener('keydown', function(e){
    if (e.key === 'Escape' && !lightbox.hidden) closeLightbox();
  });

  /* ---------------------------------------------------
     Blog — plain text posts, click a title to read it.
     Data fetched from data/blog.json.
  --------------------------------------------------- */
  var posts = [];

  function formatDate(iso){
    var d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' });
  }

  function renderBlogList(){
    var html = '<div class="post-list">';
    posts.forEach(function(post, i){
      html +=
        '<article class="post-summary">' +
          '<span class="post-date">' + formatDate(post.date) + '</span>' +
          '<button class="post-title-btn" data-index="' + i + '">' + post.title + '</button>' +
          '<p class="post-excerpt">' + post.excerpt + '</p>' +
        '</article>';
    });
    html += '</div>';
    panels.blog.innerHTML = html;
    panels.blog.querySelectorAll('.post-title-btn').forEach(function(btn){
      btn.addEventListener('click', function(){ renderBlogPost(Number(btn.dataset.index)); });
    });
  }

  function renderBlogPost(i){
    var post = posts[i];
    panels.blog.innerHTML =
      '<div class="post-full">' +
        '<button class="back-link">&larr; All posts</button>' +
        '<span class="post-date">' + formatDate(post.date) + '</span>' +
        '<h2>' + post.title + '</h2>' +
        '<div class="post-body">Loading…</div>' +
      '</div>';
    panels.blog.querySelector('.back-link').addEventListener('click', renderBlogList);

    var bodyEl = panels.blog.querySelector('.post-body');
    if (post.md !== undefined){
      bodyEl.innerHTML = renderMarkdown(post.md);
      return;
    }
    fetch('data/' + post.file)
      .then(function(r){ return r.text(); })
      .then(function(md){ post.md = md; bodyEl.innerHTML = renderMarkdown(md); })
      .catch(function(err){ console.error('Failed to load post content:', err); });
  }

  fetch('data/blog.json')
    .then(function(r){ return r.json(); })
    .then(function(data){ posts = data; renderBlogList(); })
    .catch(function(err){ console.error('Failed to load blog content:', err); });
})();
