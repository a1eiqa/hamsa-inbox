"use strict";

const main = document.querySelector("#main");
const headerActions = document.querySelector(".header-actions");
const currentUrl = new URL(window.location.href);
const messageLimit = 500;
const dateFormat = new Intl.DateTimeFormat("ar-IQ", {
  dateStyle: "medium",
  timeStyle: "short",
});

let user = null;

function fromTemplate(id) {
  return document.getElementById(id).content.firstElementChild.cloneNode(true);
}

function homeLink() {
  const url = new URL(currentUrl);
  url.search = "";
  url.hash = "";
  return url;
}

function publicLink(username) {
  const url = homeLink();
  url.searchParams.set("u", username);
  return url.href;
}

function makeButton(label, style) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "button button-" + style;
  button.textContent = label;
  return button;
}

function makeLink(label, style, href) {
  const link = document.createElement("a");
  link.className = "button button-" + style;
  link.href = href;
  link.textContent = label;
  return link;
}

function stateMessage(label, style) {
  const message = document.createElement("p");
  message.className = style;
  message.setAttribute("role", "status");
  message.textContent = label;
  return message;
}

function feedback(element, text = "", style = "") {
  element.hidden = !text;
  element.classList.toggle("is-error", style === "error");
  element.classList.toggle("is-success", style === "success");
  element.textContent = text;
}

async function request(path, method = "GET", body) {
  let response;
  try {
    response = await fetch("/api" + path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("تعذّر الاتصال. تحقق من اتصالك وحاول مرة أخرى.");
  }

  const data = await response.json().catch(() => null);
  if (!response.ok || !data) {
    const error = new Error(data?.error || "تعذّر إكمال العملية. حاول مرة أخرى.");
    error.status = response.status;
    throw error;
  }
  return data;
}

function setPage(view, title, focus = false) {
  document.title = title + " | همسة";
  main.replaceChildren(view);
  if (focus) main.focus();
}

function renderHeader(switchAuth) {
  headerActions.replaceChildren();
  if (user) {
    const workspace = makeLink("حسابي", "ghost", homeLink().href);
    const logout = makeButton("تسجيل الخروج", "secondary");
    const result = stateMessage("", "logout-feedback feedback");
    result.hidden = true;
    logout.addEventListener("click", async () => {
      logout.disabled = true;
      feedback(result);
      try {
        await request("/logout", "POST");
        window.location.assign(homeLink().href);
      } catch (error) {
        feedback(result, error.message, "error");
        logout.disabled = false;
      }
    });
    headerActions.append(workspace, logout, result);
    return;
  }

  const loginUrl = homeLink();
  loginUrl.searchParams.set("view", "login");
  const login = makeLink("تسجيل الدخول", "ghost", loginUrl.href);
  if (switchAuth) {
    login.addEventListener("click", (event) => {
      if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      event.preventDefault();
      switchAuth("login", true);
    });
  }
  headerActions.append(login);
}

function renderLanding(initialMode) {
  const view = fromTemplate("landing-template");
  const tabs = view.querySelectorAll("[data-auth]");
  const forms = view.querySelectorAll("[data-form]");
  const heading = view.querySelector(".auth-heading");
  let submitting = false;

  function switchAuth(mode, focus = false) {
    if (submitting) return;
    const login = mode === "login";
    heading.querySelector("h2").textContent = login ? "مرحبًا بعودتك" : "ابدأ مع همسة";
    heading.querySelector("p").textContent = login
      ? "سجّل دخولك لتقرأ همساتك."
      : "أنشئ حسابك لتحصل على رابطك الخاص.";
    for (const tab of tabs) {
      tab.setAttribute("aria-pressed", String(tab.dataset.auth === mode));
    }
    for (const form of forms) {
      form.hidden = form.dataset.form !== mode;
      if (!form.hidden && focus) form.querySelector("input").focus();
    }
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => switchAuth(tab.dataset.auth));
  }
  for (const form of forms) {
    const submit = form.querySelector('button[type="submit"]');
    const result = form.querySelector(".feedback");
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submitting) return;
      const fields = Object.fromEntries(new FormData(form));
      const mode = form.dataset.form;
      feedback(result);
      submitting = true;
      submit.disabled = true;
      try {
        const data = await request("/" + mode, "POST", fields);
        user = data.user;
        window.history.replaceState(null, "", homeLink());
        renderHeader();
        renderWorkspace(true);
      } catch (error) {
        feedback(result, error.message, "error");
      } finally {
        submitting = false;
        submit.disabled = false;
      }
    });
  }

  switchAuth(initialMode);
  renderHeader(switchAuth);
  setPage(view, "رسائل مجهولة");
}

function fillProfile(view, profile) {
  const bio = view.querySelector("[data-bio]");
  view.querySelector("[data-avatar]").textContent = Array.from(profile.displayName)[0];
  view.querySelector("[data-name]").textContent = profile.displayName;
  view.querySelector("[data-handle]").textContent = "@" + profile.username;
  bio.textContent = profile.bio;
  bio.hidden = !profile.bio;
}

function renderWorkspace(focus = false) {
  const view = fromTemplate("workspace-template");
  const copyResult = view.querySelector("[data-copy-feedback]");
  const shareInput = view.querySelector("#share-link");
  const profileStatus = view.querySelector("[data-profile-status]");
  const settings = view.querySelector("[data-settings]");
  shareInput.value = publicLink(user.username);
  view.querySelector("[data-public-link]").href = shareInput.value;
  settings.elements.displayName.value = user.displayName;
  settings.elements.bio.value = user.bio;
  settings.elements.accepting.checked = user.accepting;

  function updateProfile() {
    fillProfile(view, user);
    profileStatus.textContent = user.accepting ? "استقبال الهمسات مفعّل" : "استقبال الهمسات متوقّف";
    profileStatus.classList.toggle("is-closed", !user.accepting);
  }
  updateProfile();

  view.querySelector("[data-copy]").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareInput.value);
      feedback(copyResult, "نُسخ الرابط.", "success");
    } catch {
      shareInput.focus();
      shareInput.select();
      feedback(copyResult, "الرابط محدد. يمكنك نسخه يدويًا.");
    }
  });

  const tabs = view.querySelectorAll("[data-workspace]");
  const sections = view.querySelectorAll("[data-section]");
  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      const active = tab.dataset.workspace;
      for (const item of tabs) {
        item.setAttribute("aria-pressed", String(item.dataset.workspace === active));
      }
      for (const section of sections) {
        section.hidden = section.dataset.section !== active;
      }
    });
  }
  const settingsResult = settings.querySelector(".feedback");
  const save = settings.querySelector('button[type="submit"]');
  settings.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (save.disabled) return;
    const fields = {
      displayName: settings.elements.displayName.value,
      bio: settings.elements.bio.value,
      accepting: settings.elements.accepting.checked,
    };
    save.disabled = true;
    feedback(settingsResult);
    try {
      const data = await request("/profile", "PATCH", fields);
      user = data.user;
      updateProfile();
      feedback(settingsResult, "حُفظت التغييرات.", "success");
    } catch (error) {
      feedback(settingsResult, error.message, "error");
    } finally {
      save.disabled = false;
    }
  });

  setPage(view, "حسابي", focus);
  loadInbox(view);
}

function withCursor(path, cursor) {
  return cursor ? path + "?" + new URLSearchParams({ cursor }) : path;
}

function showMore(list, cursor, onClick) {
  list.querySelector(".more-row")?.remove();
  if (!cursor) return;
  const row = document.createElement("div");
  row.className = "more-row";
  const button = makeButton("عرض المزيد", "secondary");
  button.addEventListener("click", () => onClick(cursor));
  row.append(button);
  list.append(row);
}

function loadInbox(view) {
  const list = view.querySelector("[data-messages]");
  const result = view.querySelector("[data-inbox-feedback]");
  const refresh = view.querySelector("[data-refresh]");

  async function load(cursor) {
    const more = list.querySelector(".more-row button");
    if (refresh.disabled) return;
    refresh.disabled = true;
    if (more) more.disabled = true;
    feedback(result);
    const loading = stateMessage("جارٍ تحميل الهمسات…", "loading-state");
    if (!list.childElementCount) list.append(loading);
    try {
      const data = await request(withCursor("/inbox", cursor));
      if (!cursor) list.replaceChildren();
      list.querySelector(".more-row")?.remove();
      for (const message of data.messages) {
        list.append(renderMessage(message, true, () => {
          if (!list.querySelector(".message-card, .more-row")) {
            list.append(stateMessage("صندوقك فارغ الآن. شارك رابطك لتستقبل همسات.", "empty-state"));
          }
        }));
      }
      if (!list.childElementCount) {
        list.append(stateMessage("صندوقك فارغ الآن. شارك رابطك لتستقبل همسات.", "empty-state"));
      }
      showMore(list, data.nextCursor, load);
    } catch (error) {
      feedback(result, error.message, "error");
    } finally {
      loading.remove();
      refresh.disabled = false;
      if (more) more.disabled = false;
    }
  }

  refresh.addEventListener("click", () => load());
  load();
}

function renderMessage(message, isOwner, onDelete) {
  const card = fromTemplate("message-template");
  const timestamp = isOwner ? message.createdAt : message.answeredAt;
  const time = card.querySelector("time");
  if (timestamp) {
    time.dateTime = timestamp;
    time.textContent = dateFormat.format(new Date(timestamp));
  } else {
    time.hidden = true;
  }
  card.querySelector("[data-body]").textContent = message.body;
  const answerBlock = card.querySelector("[data-answer-block]");
  const answerText = card.querySelector("[data-answer]");
  if (message.answer) {
    answerBlock.hidden = false;
    answerText.textContent = message.answer;
  }
  if (!isOwner) return card;

  const actions = card.querySelector("[data-message-actions]");
  const answerForm = card.querySelector("[data-answer-form]");
  const reply = card.querySelector("[data-reply]");
  const remove = card.querySelector("[data-delete]");
  const confirmation = card.querySelector("[data-delete-confirm]");
  const confirmDelete = card.querySelector("[data-confirm-delete]");
  const result = card.querySelector(".feedback");
  const submitAnswer = answerForm.querySelector('button[type="submit"]');
  const cancelAnswer = card.querySelector("[data-cancel-answer]");
  const cancelDelete = card.querySelector("[data-cancel-delete]");
  actions.hidden = false;
  reply.hidden = Boolean(message.answer);

  reply.addEventListener("click", () => {
    actions.hidden = true;
    answerForm.hidden = false;
    answerForm.elements.answer.focus();
  });
  cancelAnswer.addEventListener("click", () => {
    feedback(result);
    actions.hidden = false;
    answerForm.hidden = true;
    reply.focus();
  });
  answerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submitAnswer.disabled) return;
    const answer = answerForm.elements.answer.value.trim();
    submitAnswer.disabled = true;
    cancelAnswer.disabled = true;
    feedback(result);
    try {
      await request("/inbox/" + encodeURIComponent(message.id) + "/answer", "POST", { answer });
      answerText.textContent = answer;
      answerBlock.hidden = false;
      reply.hidden = true;
      actions.hidden = false;
      answerForm.hidden = true;
      remove.focus();
      feedback(result, "نُشر ردّك في صفحتك.", "success");
    } catch (error) {
      feedback(result, error.message, "error");
    } finally {
      submitAnswer.disabled = false;
      cancelAnswer.disabled = false;
    }
  });

  remove.addEventListener("click", () => {
    feedback(result);
    actions.hidden = true;
    confirmation.hidden = false;
    cancelDelete.focus();
  });
  cancelDelete.addEventListener("click", () => {
    confirmation.hidden = true;
    actions.hidden = false;
    remove.focus();
  });
  confirmDelete.addEventListener("click", async () => {
    if (confirmDelete.disabled) return;
    confirmDelete.disabled = true;
    cancelDelete.disabled = true;
    feedback(result);
    try {
      await request("/inbox/" + encodeURIComponent(message.id), "DELETE");
      const visibleAction = ".message-actions:not([hidden]) button:not([hidden]), .more-row button";
      const nextFocus = card.nextElementSibling?.querySelector(visibleAction) ||
        card.previousElementSibling?.querySelector(visibleAction) ||
        main.querySelector("[data-refresh]");
      card.remove();
      onDelete();
      nextFocus?.focus();
    } catch (error) {
      feedback(result, error.message, "error");
    } finally {
      confirmDelete.disabled = false;
      cancelDelete.disabled = false;
    }
  });
  return card;
}

async function renderPublic(username) {
  const path = "/profile/" + encodeURIComponent(username);
  const data = await request(path);
  const { profile } = data;
  const view = fromTemplate("public-template");
  fillProfile(view, profile);

  const form = view.querySelector("[data-message-form]");
  const closed = view.querySelector("[data-closed]");
  const body = form.elements.body;
  const count = form.querySelector("[data-message-count]");
  const submit = form.querySelector('button[type="submit"]');
  const result = form.querySelector(".feedback");
  form.hidden = !profile.accepting;
  closed.hidden = profile.accepting;

  function updateCount() {
    const length = Array.from(body.value.trim()).length;
    count.textContent = length + " / " + messageLimit;
    body.setCustomValidity(length > messageLimit ? "الهمسة لا تتجاوز ٥٠٠ حرف." : "");
  }
  body.addEventListener("input", updateCount);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (submit.disabled) return;
    const fields = Object.fromEntries(new FormData(form));
    submit.disabled = true;
    feedback(result);
    try {
      await request(path + "/messages", "POST", fields);
      form.reset();
      updateCount();
      feedback(result, "وصلت همستك.", "success");
    } catch (error) {
      feedback(result, error.message, "error");
    } finally {
      submit.disabled = false;
    }
  });

  const answers = view.querySelector("[data-answers]");
  const paginationResult = stateMessage("", "feedback");
  paginationResult.hidden = true;
  answers.after(paginationResult);

  function appendAnswers(page) {
    answers.querySelector(".more-row")?.remove();
    for (const message of page.answers) answers.append(renderMessage(message, false));
    if (!answers.childElementCount) {
      answers.append(stateMessage("لا توجد ردود منشورة حتى الآن.", "empty-state"));
    }
    showMore(answers, page.nextCursor, async (cursor) => {
      const button = answers.querySelector(".more-row button");
      if (button.disabled) return;
      button.disabled = true;
      feedback(paginationResult);
      try {
        appendAnswers(await request(withCursor(path, cursor)));
      } catch (error) {
        feedback(paginationResult, error.message, "error");
      } finally {
        button.disabled = false;
      }
    });
  }

  appendAnswers(data);
  setPage(view, profile.displayName);
}

function renderUnavailable(title, message) {
  const view = fromTemplate("unavailable-template");
  view.querySelector("h1").textContent = title;
  view.querySelector("p").textContent = message;
  setPage(view, title);
}

async function start() {
  const username = currentUrl.searchParams.get("u");
  try {
    const data = await request("/session");
    user = data.user;
    renderHeader();
    if (username !== null) {
      await renderPublic(username);
    } else if (user) {
      renderWorkspace();
    } else {
      renderLanding(currentUrl.searchParams.get("view") === "login" ? "login" : "register");
    }
  } catch (error) {
    if (error.status === 404 && username !== null) {
      renderUnavailable("لم نجد هذه الصفحة", "تحقّق من الرابط أو اطلب رابطًا جديدًا من صاحب الصفحة.");
    } else {
      renderUnavailable("تعذّر فتح همسة", error.message);
    }
  }
}

start();
