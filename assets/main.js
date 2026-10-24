(function () {
  "use strict";

  var nav = document.querySelector(".site-nav");
  var head = document.querySelector(".shelf-head");

  var syncSticky = function () {
    if (!head) return;
    var offset = nav ? nav.offsetHeight : 0;
    head.classList.toggle("is-stuck", head.getBoundingClientRect().top <= offset + 1);
  };

  if (nav) {
    var syncNavHeight = function () {
      document.documentElement.style.setProperty("--nav-h", nav.offsetHeight + "px");
      syncSticky();
    };

    syncNavHeight();

    if ("ResizeObserver" in window) {
      new ResizeObserver(syncNavHeight).observe(nav);
    } else {
      window.addEventListener("resize", syncNavHeight);
    }
  }

  if (head) {
    window.addEventListener("scroll", syncSticky, { passive: true });
    window.addEventListener("resize", syncSticky);
    syncSticky();
  }

  var list = document.querySelector(".shelf-list");
  var more = document.querySelector(".shelf-more");
  var emptyState = document.querySelector(".shelf-empty");
  var filters = Array.prototype.slice.call(
    document.querySelectorAll(".shelf-cats [data-filter]")
  );

  if (list && filters.length) {
    var pageSize = 7;
    var entries = Array.prototype.slice.call(list.children);
    var current = "all";
    var shown = pageSize;
    var reservedHeight = 0;

    var emptyText = {
      observation: "还没有书页。看到的行业、人群和变化，会放在这里。",
      practice: "还没有书页。做出来的东西、走过的弯路，会放在这里。"
    };

    var setActive = function () {
      filters.forEach(function (button) {
        var active = button.getAttribute("data-filter") === current;
        button.classList.toggle("is-active", active);
        button.setAttribute("aria-pressed", active ? "true" : "false");
      });
    };

    var setUrl = function () {
      if (!window.history || !window.history.replaceState) return;
      var url = new URL(window.location.href);
      if (current === "all") {
        url.searchParams.delete("cat");
      } else {
        url.searchParams.set("cat", current);
      }
      window.history.replaceState(null, "", url);
    };

    var render = function () {
      var matches = entries.filter(function (entry) {
        return current === "all" || entry.getAttribute("data-cat") === current;
      });
      var previousListHeight = list.hidden ? reservedHeight : list.offsetHeight;

      entries.forEach(function (entry) {
        entry.hidden = true;
      });

      matches.slice(0, shown).forEach(function (entry) {
        entry.hidden = false;
      });

      var isEmpty = matches.length === 0;
      list.hidden = isEmpty;

      if (emptyState) {
        if (isEmpty) {
          if (previousListHeight) reservedHeight = previousListHeight;
          emptyState.style.minHeight = reservedHeight ? reservedHeight + "px" : "";
          emptyState.hidden = false;
          emptyState.textContent = emptyText[current] || "还没有书页。";
        } else {
          emptyState.hidden = true;
          emptyState.style.minHeight = "";
          reservedHeight = list.offsetHeight;
        }
      }

      if (more) {
        more.hidden = isEmpty || shown >= matches.length;
      }
    };

    var restoreShelfPosition = function (previousScroll) {
      if (!head || window.scrollY >= previousScroll - 1) return;
      var root = document.documentElement;
      var offset = nav ? nav.offsetHeight : 0;
      var top = window.scrollY + head.getBoundingClientRect().top - offset;
      var previousBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, Math.max(0, top));
      root.style.scrollBehavior = previousBehavior;
    };

    var revealFirstCard = function () {
      if (!head || !list || list.hidden) return;
      var first = null;
      for (var i = 0; i < entries.length; i += 1) {
        if (!entries[i].hidden) {
          first = entries[i];
          break;
        }
      }
      if (!first) return;

      var gap = 18;
      var headBottom = head.getBoundingClientRect().bottom;
      var delta = first.getBoundingClientRect().top - (headBottom + gap);
      if (delta >= 0) return;

      var root = document.documentElement;
      var previousBehavior = root.style.scrollBehavior;
      root.style.scrollBehavior = "auto";
      window.scrollTo(0, Math.max(0, window.scrollY + delta));
      root.style.scrollBehavior = previousBehavior;
    };

    var apply = function (value, updateUrl) {
      var previousScroll = window.scrollY;
      current = value;
      shown = pageSize;
      setActive();
      render();
      if (updateUrl) {
        setUrl();
        restoreShelfPosition(previousScroll);
      }
      syncSticky();
      revealFirstCard();
      window.requestAnimationFrame(function () {
        syncSticky();
        revealFirstCard();
      });
    };

    filters.forEach(function (button) {
      button.addEventListener("click", function () {
        apply(button.getAttribute("data-filter"), true);
      });
    });

    if (more) {
      more.addEventListener("click", function () {
        shown += pageSize;
        render();
      });
    }

    var requested = new URLSearchParams(window.location.search).get("cat");
    var isValid = filters.some(function (button) {
      return button.getAttribute("data-filter") === requested;
    });

    apply(isValid ? requested : "all", false);
  }

  var items = document.querySelectorAll(".reveal");

  if (!items.length) return;

  if (!("IntersectionObserver" in window)) {
    items.forEach(function (el) {
      el.classList.add("in");
    });
    return;
  }

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("in");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" }
  );

  items.forEach(function (el) {
    observer.observe(el);
  });
})();
