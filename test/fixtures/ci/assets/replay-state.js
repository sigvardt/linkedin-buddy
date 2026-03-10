(() => {
  const STORAGE_KEY = "linkedin_fixture_replay_state";
  const THREAD_ID = "fixture-thread-1";
  const THREAD_URL = "https://www.linkedin.com/messaging/thread/fixture-thread-1/";
  const CONVERSATIONS_URL =
    "https://www.linkedin.com/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.fixture&variables=%7B%22start%22%3A0%7D";
  const MESSAGES_URL =
    "https://www.linkedin.com/voyagerMessagingGraphQL/graphql?queryId=messengerMessages.fixture&variables=%7B%22threadId%22%3A%22fixture-thread-1%22%7D";
  const PROFILE_SLUG = "realsimonmiller";
  const PROFILE_URL = `https://www.linkedin.com/in/${PROFILE_SLUG}/`;
  const ME_URL = "https://www.linkedin.com/in/me/";
  const JOB_ID = "1234567890";
  const JOB_URL = `https://www.linkedin.com/jobs/view/${JOB_ID}/`;
  const POST_ID = "urn:li:activity:fixture-post-1";
  const POST_URL = `https://www.linkedin.com/feed/update/${POST_ID}/`;
  const BASE_POST = {
    id: POST_ID,
    url: POST_URL,
    authorName: "Simon Miller",
    authorHeadline: "Product Lead at Replay Labs",
    authorProfileUrl: PROFILE_URL,
    postedAt: "1h",
    text: "Building safe automation with fixture replay gives us deterministic LinkedIn coverage without touching production accounts.",
    reactionsCount: 12,
    repostsCount: 1
  };

  function defaultState() {
    return {
      connections: {
        received: {
          [PROFILE_SLUG]: true
        },
        sent: {}
      },
      feed: {
        comments: {
          [POST_ID]: ["Love this direction."]
        },
        posts: [],
        reactions: {},
        reposts: {},
        saved: {}
      },
      messaging: {
        [THREAD_ID]: {
          messages: [
            {
              author: "Simon Miller",
              sentAt: "2026-03-09T08:00:00.000Z",
              text: "Let's use fixture replay for safe coverage."
            },
            {
              author: "Fixture Operator",
              sentAt: "2026-03-09T09:00:00.000Z",
              text: "Sounds good — deterministic tests are much easier to trust."
            }
          ],
          snippet: "Let's use fixture replay for safe coverage.",
          title: "Simon Miller",
          unreadCount: 1
        }
      }
    };
  }

  function loadState() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const state = defaultState();
        saveState(state);
        return state;
      }

      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : defaultState();
    } catch {
      return defaultState();
    }
  }

  function saveState(state) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function getAllPosts(state) {
    return [BASE_POST, ...state.feed.posts];
  }

  function createPostHtml(post, state, singleView) {
    const comments = state.feed.comments[post.id] ?? [];
    const reaction = state.feed.reactions[post.id] ?? null;
    const reacted = reaction !== null;
    const reposted = Boolean(state.feed.reposts[post.id]);
    const saved = Boolean(state.feed.saved[post.id]);
    const commentsHidden = singleView ? "" : " hidden";
    const safeText = escapeHtml(post.text);
    const baseReactionCount = Number(post.reactionsCount) || 0;
    const baseRepostCount = Number(post.repostsCount) || 0;

    return `
      <article class="feed-shared-update-v2 occludable-update" data-urn="${escapeHtml(post.id)}">
        <a href="${escapeHtml(post.url)}" class="post-permalink">Open post</a>
        <div>
          <a href="${escapeHtml(post.authorProfileUrl)}">
            <span class="update-components-actor__name">${escapeHtml(post.authorName)}</span>
          </a>
        </div>
        <div class="update-components-actor__description">${escapeHtml(post.authorHeadline)}</div>
        <time>${escapeHtml(post.postedAt)}</time>
        <div class="update-components-text">${safeText}</div>
        <div class="social-details-social-counts__reactions-count">${baseReactionCount + (reacted ? 1 : 0)} reactions</div>
        <div class="social-details-social-counts__comments">${comments.length} comments</div>
        <div class="social-details-social-counts__reposts">${baseRepostCount + (reposted ? 1 : 0)} reposts</div>
        <div>
          <button
            class="feed-shared-control-menu__trigger"
            aria-label="More actions"
            data-post-id="${escapeHtml(post.id)}"
          >More</button>
          <div class="feed-post-actions-menu more-actions-menu" role="menu" data-post-id="${escapeHtml(post.id)}" hidden>
            <button role="menuitem" data-post-id="${escapeHtml(post.id)}" data-menu-action="${saved ? "unsave" : "save"}">${saved ? "Unsave" : "Save"}</button>
          </div>
        </div>
        <div>
          <button
            class="social-actions-button react-button__trigger${reacted ? " react-button--active" : ""}"
            aria-label="${reacted ? "Remove your reaction" : "Like"}"
            aria-pressed="${reacted ? "true" : "false"}"
            data-post-id="${escapeHtml(post.id)}"
          >Like</button>
          <button class="social-actions-button comment-button" data-post-id="${escapeHtml(post.id)}">Comment</button>
          <button
            class="social-actions-button repost-button${reposted ? " repost-button--active" : ""}"
            aria-label="${reposted ? "Reposted" : "Repost"}"
            aria-pressed="${reposted ? "true" : "false"}"
            data-post-id="${escapeHtml(post.id)}"
          >${reposted ? "Reposted" : "Repost"}</button>
        </div>
        <div class="feed-post-actions-menu repost-actions-menu" role="menu" data-post-id="${escapeHtml(post.id)}" hidden>
          <button role="menuitem" data-post-id="${escapeHtml(post.id)}" data-menu-action="repost">Repost</button>
          <button role="menuitem" data-post-id="${escapeHtml(post.id)}" data-menu-action="share">Share in a post</button>
        </div>
        <div class="comments-comment-box" data-post-id="${escapeHtml(post.id)}"${commentsHidden}>
          <div
            class="comments-comment-box__editor"
            contenteditable="true"
            role="textbox"
            aria-label="Add a comment"
            data-post-id="${escapeHtml(post.id)}"
          ></div>
          <button class="comments-comment-box__submit-button" data-post-id="${escapeHtml(post.id)}" disabled>Post</button>
        </div>
        <div class="comments-list" data-post-id="${escapeHtml(post.id)}">
          ${comments
            .map(
              (comment) => `
                <div class="comments-comment-item">
                  <div class="comments-comment-item__main-content">${escapeHtml(comment)}</div>
                </div>
              `
            )
            .join("")}
        </div>
      </article>
    `;
  }

  function createPublishedPost(text, index) {
    return {
      authorHeadline: "Fixture Operator",
      authorName: "Fixture Operator",
      authorProfileUrl: ME_URL,
      id: `urn:li:activity:fixture-user-post-${index}`,
      postedAt: "Just now",
      reactionsCount: 0,
      repostsCount: 0,
      text,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:fixture-user-post-${index}/`
    };
  }

  function renderFeed(singleView = false) {
    const root = document.querySelector("#replay-root");
    const state = loadState();
    const posts = getAllPosts(state);
    const visiblePosts = singleView
      ? posts.filter((post) => post.url === window.location.href || post.id === POST_ID)
      : posts;

    root.innerHTML = `
      <section class="share-box-feed-entry">
        <button class="share-box-feed-entry__trigger" aria-label="Start a post">Start a post</button>
      </section>
      <section class="composer-dialog" role="dialog" hidden>
        <button class="composer-close" aria-label="Close">Close</button>
        <button class="composer-visibility" aria-label="Anyone">Anyone</button>
        <div class="ql-editor" contenteditable="true" role="textbox" aria-label="What do you want to talk about?"></div>
        <button class="share-actions__primary-action" disabled>Post</button>
      </section>
      ${visiblePosts.map((post) => createPostHtml(post, state, singleView)).join("")}
    `;

    const likeButtons = root.querySelectorAll(".react-button__trigger");
    likeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const freshState = loadState();
        const postId = button.getAttribute("data-post-id");
        if (!postId) {
          return;
        }

        if (freshState.feed.reactions[postId]) {
          delete freshState.feed.reactions[postId];
        } else {
          freshState.feed.reactions[postId] = "like";
        }

        saveState(freshState);
        renderFeed(singleView);
      });
    });

    function hideFeedMenus() {
      root.querySelectorAll(".feed-post-actions-menu").forEach((menu) => {
        menu.setAttribute("hidden", "");
      });
    }

    root.querySelectorAll(".feed-shared-control-menu__trigger").forEach((button) => {
      button.addEventListener("click", () => {
        const postId = button.getAttribute("data-post-id");
        const menu = root.querySelector(`.more-actions-menu[data-post-id="${postId}"]`);
        if (!menu) {
          return;
        }

        const isHidden = menu.hasAttribute("hidden");
        hideFeedMenus();
        if (isHidden) {
          menu.removeAttribute("hidden");
        }
      });
    });

    root.querySelectorAll(".more-actions-menu [data-menu-action]").forEach((button) => {
      button.addEventListener("click", () => {
        const freshState = loadState();
        const postId = button.getAttribute("data-post-id");
        const action = button.getAttribute("data-menu-action");
        if (!postId || !action) {
          return;
        }

        if (action === "save") {
          freshState.feed.saved[postId] = true;
        }
        if (action === "unsave") {
          delete freshState.feed.saved[postId];
        }

        saveState(freshState);
        renderFeed(singleView);
      });
    });

    root.querySelectorAll(".repost-button").forEach((button) => {
      button.addEventListener("click", () => {
        const postId = button.getAttribute("data-post-id");
        const menu = root.querySelector(`.repost-actions-menu[data-post-id="${postId}"]`);
        if (!menu) {
          return;
        }

        const isHidden = menu.hasAttribute("hidden");
        hideFeedMenus();
        if (isHidden) {
          menu.removeAttribute("hidden");
        }
      });
    });

    root.querySelectorAll(".comment-button").forEach((button) => {
      button.addEventListener("click", () => {
        const postId = button.getAttribute("data-post-id");
        const editor = root.querySelector(`.comments-comment-box[data-post-id="${postId}"]`);
        if (editor) {
          editor.removeAttribute("hidden");
        }
      });
    });

    root.querySelectorAll(".comments-comment-box__editor").forEach((editor) => {
      editor.addEventListener("input", () => {
        const postId = editor.getAttribute("data-post-id");
        const submit = root.querySelector(`.comments-comment-box__submit-button[data-post-id="${postId}"]`);
        if (!(submit instanceof HTMLButtonElement)) {
          return;
        }

        submit.disabled = editor.textContent.trim().length === 0;
      });
    });

    root.querySelectorAll(".comments-comment-box__submit-button").forEach((button) => {
      button.addEventListener("click", () => {
        const freshState = loadState();
        const postId = button.getAttribute("data-post-id");
        const editor = root.querySelector(`.comments-comment-box__editor[data-post-id="${postId}"]`);
        if (!(editor instanceof HTMLElement) || !postId) {
          return;
        }

        const text = editor.textContent.trim();
        if (!text) {
          return;
        }

        if (!Array.isArray(freshState.feed.comments[postId])) {
          freshState.feed.comments[postId] = [];
        }
        freshState.feed.comments[postId].push(text);
        saveState(freshState);
        renderFeed(singleView);
      });
    });

    const trigger = root.querySelector(".share-box-feed-entry__trigger");
    const dialog = root.querySelector(".composer-dialog");
    const editor = root.querySelector(".ql-editor");
    const publish = root.querySelector(".share-actions__primary-action");
    const close = root.querySelector(".composer-close");
    if (trigger && dialog && editor && publish && close) {
      function resetComposerDialog() {
        dialog.setAttribute("hidden", "");
        dialog.removeAttribute("data-shared-post-id");
        editor.textContent = "";
        publish.disabled = true;
      }

      trigger.addEventListener("click", () => {
        hideFeedMenus();
        dialog.removeAttribute("data-shared-post-id");
        editor.textContent = "";
        publish.disabled = true;
        dialog.removeAttribute("hidden");
      });

      root.querySelectorAll(".repost-actions-menu [data-menu-action]").forEach((button) => {
        button.addEventListener("click", () => {
          const freshState = loadState();
          const postId = button.getAttribute("data-post-id");
          const action = button.getAttribute("data-menu-action");
          if (!postId || !action) {
            return;
          }

          if (action === "repost") {
            freshState.feed.reposts[postId] = true;
            saveState(freshState);
            renderFeed(singleView);
            return;
          }

          if (action === "share") {
            hideFeedMenus();
            dialog.setAttribute("data-shared-post-id", postId);
            editor.textContent = "";
            publish.disabled = true;
            dialog.removeAttribute("hidden");
          }
        });
      });

      editor.addEventListener("input", () => {
        publish.disabled = editor.textContent.trim().length === 0;
      });

      close.addEventListener("click", () => {
        resetComposerDialog();
      });

      publish.addEventListener("click", () => {
        const text = editor.textContent.trim();
        if (!text) {
          return;
        }

        const freshState = loadState();
        const nextIndex = freshState.feed.posts.length + 1;
        freshState.feed.posts.unshift(createPublishedPost(text, nextIndex));
        saveState(freshState);
        resetComposerDialog();
        renderFeed(singleView);
      });
    }
  }

  function renderMessagingList() {
    const root = document.querySelector("#replay-root");
    const state = loadState();
    const thread = state.messaging[THREAD_ID];
    root.innerHTML = `
      <main class="msg-conversations-container">
        <a href="${THREAD_URL}" class="msg-conversation-card">
          <div class="msg-conversation-card__participant-names">${escapeHtml(thread.title)}</div>
          <div class="msg-conversation-card__message-snippet">${escapeHtml(thread.snippet)}</div>
          <div class="msg-conversation-card__unread-count">${escapeHtml(thread.unreadCount)}</div>
        </a>
      </main>
    `;

    void fetch(CONVERSATIONS_URL).catch(() => undefined);
  }

  function renderMessagingThread() {
    const root = document.querySelector("#replay-root");
    const state = loadState();
    const thread = state.messaging[THREAD_ID];
    root.innerHTML = `
      <main class="msg-s-message-list-content">
        <h2 class="msg-thread__participant-names">${escapeHtml(thread.title)}</h2>
        <div class="msg-s-message-list">
          ${thread.messages
            .map(
              (message) => `
                <div class="msg-s-event-listitem msg-s-message-list__event">
                  <div class="msg-s-message-group__profile-link">${escapeHtml(message.author)}</div>
                  <div class="msg-s-event-listitem__body">${escapeHtml(message.text)}</div>
                  <time>${escapeHtml(message.sentAt)}</time>
                </div>
              `
            )
            .join("")}
        </div>
        <div class="msg-form">
          <div class="msg-form__contenteditable" contenteditable="true" role="textbox" aria-label="Write a message"></div>
          <button class="msg-form__send-button">Send</button>
        </div>
      </main>
    `;

    void fetch(MESSAGES_URL).catch(() => undefined);

    const composer = root.querySelector(".msg-form__contenteditable");
    const sendButton = root.querySelector(".msg-form__send-button");
    if (composer && sendButton) {
      sendButton.addEventListener("click", () => {
        const text = composer.textContent.trim();
        if (!text) {
          return;
        }

        const freshState = loadState();
        freshState.messaging[THREAD_ID].messages.push({
          author: "Fixture Operator",
          sentAt: new Date().toISOString(),
          text
        });
        freshState.messaging[THREAD_ID].snippet = text;
        freshState.messaging[THREAD_ID].unreadCount = 0;
        saveState(freshState);
        renderMessagingThread();
      });
    }
  }

  function profileSummary(slug) {
    if (slug === "me") {
      return {
        fullName: "Fixture Operator",
        headline: "Automation Engineer",
        location: "Copenhagen, Denmark",
        about: "I build safe automation workflows and deterministic browser fixtures.",
        degree: "1st"
      };
    }

    return {
      fullName: "Simon Miller",
      headline: "Product Lead at Replay Labs",
      location: "London, United Kingdom",
      about: "Curious about safe automation, fixture replay, and robust test harnesses.",
      degree: "2nd"
    };
  }

  function renderProfile(slug) {
    const root = document.querySelector("#replay-root");
    const state = loadState();
    const profile = profileSummary(slug);
    const sent = Boolean(state.connections.sent[slug]);

    root.innerHTML = `
      <section class="pv-top-card">
        <h1 class="text-heading-xlarge">${escapeHtml(profile.fullName)}</h1>
        <div class="text-body-medium" data-anonymize="headline">${escapeHtml(profile.headline)}</div>
        <span class="text-body-small inline" data-anonymize="location">${escapeHtml(profile.location)}</span>
        <div class="dist-value">${escapeHtml(profile.degree)}</div>
        ${slug === "me" ? "" : `<button class="profile-connect ${sent ? "pending" : ""}" aria-label="${sent ? "Withdraw" : "Connect"}">${sent ? "Pending" : "Connect"}</button>`}
        ${slug === "me" ? "" : `<div class="invitation-status">${sent ? "Invitation sent" : ""}</div>`}
      </section>
      ${slug === "me" ? "" : `
        <section class="connect-dialog" hidden>
          <button class="connect-add-note">Add a note</button>
          <textarea name="message" aria-label="Invitation"></textarea>
          <button class="connect-send">Send</button>
        </section>
      `}
      <section id="about">
        <h2>About</h2>
        <div class="inline-show-more-text">${escapeHtml(profile.about)}</div>
      </section>
      <section id="experience">
        <h2>Experience</h2>
        <ul class="clean-list">
          <li class="pvs-list__paged-list-item">
            <div class="t-bold">Replay Labs</div>
            <div class="t-normal">${escapeHtml(profile.headline)}</div>
            <div class="pvs-entity__caption-wrapper">2024 – Present</div>
            <div class="pvs-entity__description-wrapper">Owning safe automation and reliability.</div>
          </li>
        </ul>
      </section>
      <section id="education">
        <h2>Education</h2>
        <ul class="clean-list">
          <li class="pvs-list__paged-list-item">
            <div class="t-bold">Technical University</div>
            <div class="t-normal">Computer Science</div>
            <div class="pvs-entity__caption-wrapper">2012 – 2015</div>
          </li>
        </ul>
      </section>
    `;

    const connectButton = root.querySelector(".profile-connect");
    const dialog = root.querySelector(".connect-dialog");
    const send = root.querySelector(".connect-send");
    const textarea = root.querySelector("textarea[name='message']");
    if (connectButton && dialog && send && textarea) {
      connectButton.addEventListener("click", () => {
        if (connectButton.textContent.trim() === "Pending") {
          return;
        }
        dialog.removeAttribute("hidden");
      });

      send.addEventListener("click", () => {
        const freshState = loadState();
        freshState.connections.sent[slug] = {
          note: textarea.value,
          pending: true
        };
        saveState(freshState);
        renderProfile(slug);
      });
    }
  }

  function renderConnectionsList() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <ul class="clean-list">
        <li class="mn-connection-card">
          <a href="${PROFILE_URL}"><span class="mn-connection-card__name">Simon Miller</span></a>
          <div class="mn-connection-card__occupation">Product Lead at Replay Labs</div>
          <time>Connected 2 years ago</time>
        </li>
      </ul>
    `;
  }

  function renderInvitations(received) {
    const root = document.querySelector("#replay-root");
    const state = loadState();
    const card = received
      ? state.connections.received[PROFILE_SLUG]
      : state.connections.sent[PROFILE_SLUG];
    const listItems = [];

    if (card) {
      listItems.push(`
        <li class="invitation-card">
          <a href="${PROFILE_URL}"><span class="invitation-card__title">Simon Miller</span></a>
          <div class="invitation-card__subtitle">Product Lead at Replay Labs</div>
          ${received ? `<button class="accept">Accept</button><button>Ignore</button>` : `<button class="withdraw-trigger">Withdraw</button><div>Invitation sent</div>`}
        </li>
      `);
    }

    root.innerHTML = `
      <ul class="clean-list">
        ${listItems.join("")}
      </ul>
      <section class="withdraw-dialog" hidden>
        <button class="withdraw-confirm">Withdraw</button>
      </section>
    `;

    if (received) {
      const accept = root.querySelector(".accept");
      if (accept) {
        accept.addEventListener("click", () => {
          const freshState = loadState();
          delete freshState.connections.received[PROFILE_SLUG];
          saveState(freshState);
          renderInvitations(true);
        });
      }
      return;
    }

    const withdrawTrigger = root.querySelector(".withdraw-trigger");
    const withdrawDialog = root.querySelector(".withdraw-dialog");
    const withdrawConfirm = root.querySelector(".withdraw-confirm");
    if (withdrawTrigger && withdrawDialog && withdrawConfirm) {
      withdrawTrigger.addEventListener("click", () => {
        withdrawDialog.removeAttribute("hidden");
      });
      withdrawConfirm.addEventListener("click", () => {
        const freshState = loadState();
        delete freshState.connections.sent[PROFILE_SLUG];
        saveState(freshState);
        renderInvitations(false);
      });
    }
  }

  function renderSearchPeople() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <div class="reusable-search__result-container">
        <div class="entity-result__title-text">
          <a href="${PROFILE_URL}"><span aria-hidden="true">Simon Miller</span></a>
        </div>
        <div class="entity-result__primary-subtitle">Product Lead at Replay Labs</div>
        <div class="entity-result__secondary-subtitle">London, United Kingdom</div>
        <div class="dist-value">2nd</div>
      </div>
    `;
  }

  function renderSearchCompanies() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <div class="reusable-search__result-container">
        <img alt="Replay Labs logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
        <div class="entity-result__title-text">
          <a href="https://www.linkedin.com/company/replay-labs/"><span aria-hidden="true">Power International</span></a>
        </div>
        <div class="entity-result__primary-subtitle">Software company</div>
        <div class="entity-result__secondary-subtitle">Copenhagen, Denmark</div>
        <div class="entity-result__summary">Building reliable product systems.</div>
      </div>
    `;
  }

  function renderSearchJobs() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <div class="job-card-container">
        <a class="job-card-container__link" href="${JOB_URL}">Software Engineer</a>
        <div class="job-card-container__company-name">Replay Labs</div>
        <div class="job-card-container__metadata-wrapper">Copenhagen, Denmark</div>
        <time>2 days ago</time>
      </div>
    `;
  }

  function renderJobsSearch() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <main class="jobs-search-results-list">
        <div class="job-card-container">
          <a class="job-card-container__link" href="${JOB_URL}">Software Engineer</a>
          <div class="job-card-container__company-name">Replay Labs</div>
          <div class="job-card-container__metadata-wrapper">Copenhagen, Denmark</div>
          <time>2 days ago</time>
          <div class="job-card-container__salary-info">€80,000 – €95,000</div>
        </div>
      </main>
    `;
  }

  function renderJobView() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <main class="jobs-details job-view-layout">
        <div class="job-details-jobs-unified-top-card">
          <h1 class="job-details-jobs-unified-top-card__job-title">Software Engineer</h1>
          <a href="https://www.linkedin.com/company/replay-labs/" class="job-details-jobs-unified-top-card__company-name">Replay Labs</a>
          <div class="job-details-jobs-unified-top-card__bullet">Copenhagen, Denmark</div>
          <div class="job-details-jobs-unified-top-card__posted-date">Posted 2 days ago</div>
          <div class="job-details-jobs-unified-top-card__job-insight">Full-time</div>
        </div>
        <div class="jobs-description__content">Build safe automation tooling and deterministic replay systems.</div>
      </main>
    `;
  }

  function renderNotifications() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `
      <main>
        <h1>Notifications</h1>
        <article class="notification-card" data-notification-id="notif-1" data-notification-type="comment" data-unread="true">
          <div class="notification-card__message">Simon Miller commented on your post about fixture replay.</div>
          <time class="notification-card__time">1h</time>
          <a href="${POST_URL}">Open notification</a>
        </article>
        <article class="notification-card" data-notification-id="notif-2" data-notification-type="connection" data-unread="false">
          <div class="notification-card__message">You have a new connection invitation.</div>
          <time class="notification-card__time">2h</time>
          <a href="https://www.linkedin.com/notifications/">Open notification</a>
        </article>
      </main>
    `;
  }

  function renderUnknown() {
    const root = document.querySelector("#replay-root");
    root.innerHTML = `<main><h1>Unknown replay route</h1><p>${escapeHtml(window.location.href)}</p></main>`;
  }

  function renderPage() {
    const pathName = window.location.pathname;
    const normalizedPath = pathName.endsWith("/") ? pathName : `${pathName}/`;

    if (normalizedPath === "/feed/") {
      renderFeed(false);
      return;
    }

    if (normalizedPath.startsWith("/feed/update/")) {
      renderFeed(true);
      return;
    }

    if (normalizedPath === "/messaging/") {
      renderMessagingList();
      return;
    }

    if (normalizedPath === "/messaging/thread/fixture-thread-1/") {
      renderMessagingThread();
      return;
    }

    if (normalizedPath === "/in/me/") {
      renderProfile("me");
      return;
    }

    if (normalizedPath === `/${`in/${PROFILE_SLUG}`}/`) {
      renderProfile(PROFILE_SLUG);
      return;
    }

    if (normalizedPath === "/mynetwork/invite-connect/connections/") {
      renderConnectionsList();
      return;
    }

    if (normalizedPath === "/mynetwork/invitation-manager/") {
      renderInvitations(true);
      return;
    }

    if (normalizedPath === "/mynetwork/invitation-manager/sent/") {
      renderInvitations(false);
      return;
    }

    if (normalizedPath === "/search/results/people/") {
      renderSearchPeople();
      return;
    }

    if (normalizedPath === "/search/results/companies/") {
      renderSearchCompanies();
      return;
    }

    if (normalizedPath === "/search/results/jobs/") {
      renderSearchJobs();
      return;
    }

    if (normalizedPath === "/jobs/search/") {
      renderJobsSearch();
      return;
    }

    if (normalizedPath === `/jobs/view/${JOB_ID}/`) {
      renderJobView();
      return;
    }

    if (normalizedPath === "/notifications/") {
      renderNotifications();
      return;
    }

    renderUnknown();
  }

  document.addEventListener("DOMContentLoaded", () => {
    renderPage();
  });
})();
