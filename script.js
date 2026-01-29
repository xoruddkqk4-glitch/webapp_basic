// 간단한 로컬 스토리지 키
const STORAGE_KEY = "board_posts_with_period";

// 첨부파일 최대 크기 (2MB)
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024;

// 게시 기간 목록 정렬 상태: { by: 'startDate'|'endDate'|null, order: 'asc'|'desc' }
let listSort = { by: null, order: "asc" };

/**
 * 저장된 게시물 목록 불러오기
 */
function loadPosts() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    console.error("Failed to load posts from storage", e);
    return [];
  }
}

/**
 * 게시물 목록 저장하기
 * @param {Array} posts
 */
function savePosts(posts) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(posts));
  } catch (e) {
    console.error("Failed to save posts to storage", e);
  }
}

/**
 * 게시 상태 계산 (예: 진행중, 예정, 종료)
 */
function getPostStatus(startDate, endDate) {
  if (!startDate || !endDate) return { code: "unknown", label: "기간 미설정" };
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const s = new Date(startDate);
  const e = new Date(endDate);
  s.setHours(0, 0, 0, 0);
  e.setHours(0, 0, 0, 0);

  if (today < s) {
    return { code: "pending", label: "게시 예정" };
  }
  if (today > e) {
    return { code: "expired", label: "게시 종료" };
  }
  return { code: "active", label: "게시 중" };
}

/**
 * 게시 기간 텍스트
 */
function formatPeriod(startDate, endDate) {
  if (!startDate || !endDate) return "기간 정보 없음";
  return `${startDate} ~ ${endDate}`;
}

/**
 * 첨부파일을 base64로 읽기 (Promise)
 */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(",")[1] || "";
      resolve({ fileName: file.name, mimeType: file.type || "application/octet-stream", dataBase64: base64 });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 단일 게시물 DOM 요소 생성 (가로형 목록용: 제목 | 부서 | 담당자 | 시작일 | 종료일 | 상태 | 첨부파일 | 삭제)
 */
function createPostElement(post, index, onDelete) {
  const status = getPostStatus(post.startDate, post.endDate);

  const container = document.createElement("article");
  container.className = "post-item";
  container.dataset.index = String(index);

  const title = document.createElement("div");
  title.className = "post-title";
  title.textContent = post.title || "(제목 없음)";

  const department = document.createElement("div");
  department.className = "post-meta";
  department.textContent = post.department ?? "-";

  const personInCharge = document.createElement("div");
  personInCharge.className = "post-meta";
  personInCharge.textContent = post.personInCharge ?? post.author ?? "익명";

  const startDateEl = document.createElement("div");
  startDateEl.className = "post-date-start";
  startDateEl.textContent = post.startDate || "-";

  const endDateEl = document.createElement("div");
  endDateEl.className = "post-date-end";
  endDateEl.textContent = post.endDate || "-";

  const statusSpan = document.createElement("span");
  statusSpan.className = `post-status ${status.code}`;
  statusSpan.textContent = status.label;

  const attCell = document.createElement("div");
  attCell.className = "post-attachment";
  if (post.attachment && post.attachment.fileName) {
    const a = document.createElement("a");
    a.href = "data:" + (post.attachment.mimeType || "") + ";base64," + (post.attachment.dataBase64 || "");
    a.download = post.attachment.fileName;
    a.className = "btn-download";
    a.textContent = "다운로드";
    attCell.appendChild(a);
  } else {
    attCell.textContent = "-";
    attCell.style.color = "#9ca3af";
  }

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "post-delete";
  deleteBtn.textContent = "삭제";
  deleteBtn.addEventListener("click", () => onDelete(index));

  container.appendChild(department);
  container.appendChild(personInCharge);
  container.appendChild(title);
  container.appendChild(startDateEl);
  container.appendChild(endDateEl);
  container.appendChild(statusSpan);
  container.appendChild(attCell);
  container.appendChild(deleteBtn);

  return container;
}

/**
 * 목록에서 드래그로 순서 변경 (전체 배열 기준)
 */
function reorderPostsByIndex(posts, fromIndex, toIndex) {
  if (fromIndex === toIndex) return posts;
  const newPosts = [...posts];
  const [removed] = newPosts.splice(fromIndex, 1);
  let insertAt = toIndex;
  if (fromIndex < toIndex) insertAt -= 1;
  newPosts.splice(insertAt, 0, removed);
  return newPosts;
}

/**
 * 간트 차트에서 드래그로 순서 변경 (기간 있는 항목만 재정렬 후 전체 배열 재구성)
 */
function reorderPostsByGanttIndices(posts, fromGanttIndex, toGanttIndex) {
  const withDatesIndices = [];
  posts.forEach((p, i) => {
    if (p.startDate && p.endDate) withDatesIndices.push(i);
  });
  if (fromGanttIndex === toGanttIndex) return posts;
  const reordered = [...withDatesIndices];
  const [removed] = reordered.splice(fromGanttIndex, 1);
  let insertAt = toGanttIndex;
  if (fromGanttIndex < toGanttIndex) insertAt -= 1;
  reordered.splice(insertAt, 0, removed);
  const withoutIndices = posts.map((_, i) => i).filter((i) => !withDatesIndices.includes(i)).sort((a, b) => a - b);
  const fullNewOrder = [...reordered];
  withoutIndices.forEach((idx) => {
    fullNewOrder.splice(idx, 0, idx);
  });
  return fullNewOrder.map((i) => posts[i]);
}

/**
 * 정렬 적용한 목록 반환 (시작일/종료일 오름·내림차순)
 */
function getDisplayPosts(posts) {
  if (!posts.length || !listSort.by) return [...posts];
  const key = listSort.by;
  const order = listSort.order === "asc" ? 1 : -1;
  return [...posts].sort((a, b) => {
    const va = a[key] || "";
    const vb = b[key] || "";
    return order * (va < vb ? -1 : va > vb ? 1 : 0);
  });
}

/**
 * 게시물 목록 렌더링 (가로형 테이블) + 드래그 앤 드롭 + 정렬
 */
function renderPosts(posts) {
  const listEl = document.getElementById("post-list");
  if (!listEl) return;

  const displayPosts = getDisplayPosts(posts);

  listEl.innerHTML = "";
  listEl.classList.remove("post-list--table");

  if (!posts.length) {
    const empty = document.createElement("p");
    empty.className = "helper-text";
    empty.textContent = "아직 등록된 게시물이 없습니다. 위 폼을 이용해 첫 게시물을 등록해 보세요.";
    listEl.appendChild(empty);
    renderGanttChart(posts);
    return;
  }

  listEl.classList.add("post-list--table");

  const header = document.createElement("div");
  header.className = "post-list-header";
  header.innerHTML = "<span>부서</span><span>담당자</span><span>제목</span><span></span><span></span><span>상태</span><span>첨부파일</span><span></span>";

  const startDateCol = header.children[3];
  startDateCol.className = "post-list-header-sort";
  startDateCol.textContent = "시작일";
  startDateCol.title = "클릭하여 정렬";
  if (listSort.by === "startDate") startDateCol.textContent += listSort.order === "asc" ? " ▲" : " ▼";
  startDateCol.addEventListener("click", () => {
    if (listSort.by === "startDate") listSort.order = listSort.order === "asc" ? "desc" : "asc";
    else listSort = { by: "startDate", order: "asc" };
    renderPosts(posts);
  });

  const endDateCol = header.children[4];
  endDateCol.className = "post-list-header-sort";
  endDateCol.textContent = "종료일";
  endDateCol.title = "클릭하여 정렬";
  if (listSort.by === "endDate") endDateCol.textContent += listSort.order === "asc" ? " ▲" : " ▼";
  endDateCol.addEventListener("click", () => {
    if (listSort.by === "endDate") listSort.order = listSort.order === "asc" ? "desc" : "asc";
    else listSort = { by: "endDate", order: "asc" };
    renderPosts(posts);
  });

  listEl.appendChild(header);

  displayPosts.forEach((post, index) => {
    const item = createPostElement(post, index, (idx) => {
      const toRemove = displayPosts[idx];
      const newPosts = posts.filter((p) => p !== toRemove);
      savePosts(newPosts);
      renderPosts(newPosts);
      renderGanttChart(newPosts);
    });
    item.draggable = true;
    item.dataset.index = String(index);
    item.classList.add("post-item--draggable");
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", index);
      e.dataTransfer.effectAllowed = "move";
      item.classList.add("post-item--dragging");
    });
    item.addEventListener("dragend", () => item.classList.remove("post-item--dragging"));
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = parseInt(item.dataset.index, 10);
      if (from === to) return;
      const reordered = reorderPostsByIndex(displayPosts, from, to);
      savePosts(reordered);
      listSort = { by: null, order: "asc" };
      renderPosts(reordered);
      renderGanttChart(reordered);
    });
    listEl.appendChild(item);
  });

  renderGanttChart(displayPosts);
}

/**
 * 게시물 목록에서 날짜 범위 계산 (간트 차트용)
 */
function getDateRange(posts) {
  let min = null;
  let max = null;
  posts.forEach((p) => {
    if (p.startDate) {
      const d = new Date(p.startDate);
      if (min === null || d < min) min = d;
    }
    if (p.endDate) {
      const d = new Date(p.endDate);
      if (max === null || d > max) max = d;
    }
  });
  if (min === null || max === null || min > max) return null;
  const pad = (max - min) * 0.05 || 86400000 * 7;
  return { min: new Date(min.getTime() - pad), max: new Date(max.getTime() + pad) };
}

/**
 * 간트 차트 렌더링
 */
function renderGanttChart(posts) {
  const el = document.getElementById("gantt-chart");
  if (!el) return;

  el.innerHTML = "";

  const withDates = (posts || []).filter((p) => p.startDate && p.endDate);
  if (withDates.length === 0) {
    const empty = document.createElement("p");
    empty.className = "gantt-empty";
    empty.textContent = "게시 기간이 있는 게시물이 없습니다. 게시물을 등록하면 여기에 표시됩니다.";
    el.appendChild(empty);
    return;
  }

  const range = getDateRange(withDates);
  if (!range) return;

  const totalMs = range.max - range.min;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const rangeMinNorm = new Date(range.min);
  rangeMinNorm.setHours(0, 0, 0, 0);
  const rangeMaxNorm = new Date(range.max);
  rangeMaxNorm.setHours(0, 0, 0, 0);
  let todayPct;
  if (today < rangeMinNorm) {
    todayPct = 25;
  } else if (today > rangeMaxNorm) {
    todayPct = 100;
  } else {
    todayPct = ((today - range.min) / totalMs) * 100;
  }
  todayPct = Math.max(0, Math.min(100, todayPct));
  const todayStr = today.toISOString().slice(0, 10);
  el.style.setProperty("--today-pct", String(todayPct));

  const header = document.createElement("div");
  header.className = "gantt-timeline-header";

  const labelHeader = document.createElement("div");
  labelHeader.className = "gantt-label-header";
  labelHeader.textContent = "제목";

  const datesHeader = document.createElement("div");
  datesHeader.className = "gantt-dates-header";
  const startStr = range.min.toISOString().slice(0, 10);
  const endStr = range.max.toISOString().slice(0, 10);
  datesHeader.innerHTML = "";
  const datesLabelStart = document.createElement("span");
  datesLabelStart.className = "gantt-header-date";
  datesLabelStart.textContent = "시작일 " + startStr;
  const datesLabelEnd = document.createElement("span");
  datesLabelEnd.className = "gantt-header-date";
  datesLabelEnd.textContent = "종료일 " + endStr;
  datesHeader.appendChild(datesLabelStart);
  datesHeader.appendChild(datesLabelEnd);

  header.appendChild(labelHeader);
  header.appendChild(datesHeader);
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "gantt-timeline-body";
  body.style.setProperty("--today-pct", String(todayPct));

  const todayLine = document.createElement("div");
  todayLine.className = "gantt-today-line";
  body.appendChild(todayLine);

  withDates.forEach((post, ganttIndex) => {
    const row = document.createElement("div");
    row.className = "gantt-row gantt-row--draggable";
    row.draggable = true;
    row.dataset.ganttIndex = String(ganttIndex);

    const labelWrap = document.createElement("div");
    labelWrap.className = "gantt-row-label-wrap";

    const label = document.createElement("div");
    label.className = "gantt-row-label";
    label.title = (post.title || "(제목 없음)") + " (" + post.startDate + " ~ " + post.endDate + ")";
    label.textContent = post.title || "(제목 없음)";

    labelWrap.appendChild(label);

    const barWrap = document.createElement("div");
    barWrap.className = "gantt-row-bar-wrap";

    const datesRow = document.createElement("div");
    datesRow.className = "gantt-cell-dates-row";
    const startDateCell = document.createElement("span");
    startDateCell.className = "gantt-cell-date";
    startDateCell.textContent = post.startDate;
    const endDateCell = document.createElement("span");
    endDateCell.className = "gantt-cell-date";
    endDateCell.textContent = post.endDate;
    datesRow.appendChild(startDateCell);
    datesRow.appendChild(endDateCell);

    const barRow = document.createElement("div");
    barRow.className = "gantt-cell-bar-row";

    const start = new Date(post.startDate).getTime();
    const end = new Date(post.endDate).getTime();
    const leftPct = ((start - range.min) / totalMs) * 100;
    const widthPct = ((end - start) / totalMs) * 100;

    const bar = document.createElement("div");
    bar.className = "gantt-bar " + getPostStatus(post.startDate, post.endDate).code;
    bar.style.left = leftPct + "%";
    bar.style.width = Math.max(widthPct, 2) + "%";
    bar.title = post.startDate + " ~ " + post.endDate;

    barRow.appendChild(bar);
    barWrap.appendChild(datesRow);
    barWrap.appendChild(barRow);
    row.appendChild(labelWrap);
    row.appendChild(barWrap);

    row.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", ganttIndex);
      e.dataTransfer.effectAllowed = "move";
      row.classList.add("gantt-row--dragging");
    });
    row.addEventListener("dragend", () => row.classList.remove("gantt-row--dragging"));
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = parseInt(row.dataset.ganttIndex, 10);
      if (from === to) return;
      const newPosts = reorderPostsByGanttIndices(posts, from, to);
      savePosts(newPosts);
      renderPosts(newPosts);
    });

    body.appendChild(row);
  });

  el.appendChild(body);

  const todayCaptionWrap = document.createElement("div");
  todayCaptionWrap.className = "gantt-today-caption-wrap";
  const todayCaption = document.createElement("span");
  todayCaption.className = "gantt-today-caption";
  todayCaption.textContent = "오늘 " + todayStr;
  todayCaptionWrap.appendChild(todayCaption);
  el.appendChild(todayCaptionWrap);
}

/**
 * 폼 초기화 및 이벤트 설정
 */
function initApp() {
  const form = document.getElementById("post-form");
  const clearAllBtn = document.getElementById("clear-all");

  if (!form) return;

  // 오늘 날짜를 기본값으로 설정
  const startInput = document.getElementById("startDate");
  const endInput = document.getElementById("endDate");
  const todayStr = new Date().toISOString().slice(0, 10);
  if (startInput && !startInput.value) startInput.value = todayStr;
  if (endInput && !endInput.value) endInput.value = todayStr;

  // 기존 게시물 렌더링
  let posts = loadPosts();
  renderPosts(posts);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const formData = new FormData(form);
    const department = (formData.get("department") || "").toString().trim();
    const personInCharge = (formData.get("personInCharge") || "").toString().trim();
    const title = (formData.get("title") || "").toString().trim();
    const startDate = (formData.get("startDate") || "").toString();
    const endDate = (formData.get("endDate") || "").toString();
    const fileInput = form.querySelector("#attachment");

    if (!department || !personInCharge || !title || !startDate || !endDate) {
      alert("부서, 담당자, 제목, 게시 시작일, 게시 종료일은 필수입니다.");
      return;
    }

    if (endDate < startDate) {
      alert("게시 종료일은 게시 시작일보다 빠를 수 없습니다.");
      return;
    }

    let attachment = null;
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      if (file.size > MAX_ATTACHMENT_SIZE) {
        alert("첨부파일은 최대 2MB까지 가능합니다.");
        return;
      }
      try {
        attachment = await readFileAsBase64(file);
      } catch (e) {
        alert("첨부파일을 읽는 중 오류가 발생했습니다.");
        return;
      }
    }

    const createdAt = new Date().toISOString().slice(0, 10);

    const newPost = {
      id: Date.now(),
      department,
      personInCharge,
      title,
      startDate,
      endDate,
      createdAt,
      attachment: attachment || undefined,
    };

    posts = [newPost, ...posts];
    savePosts(posts);
    renderPosts(posts);

    form.querySelector("#title").value = "";
    form.querySelector("#department").value = "";
    form.querySelector("#personInCharge").value = "";
    if (fileInput) fileInput.value = "";
  });

  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", () => {
      if (!confirm("모든 게시물을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) return;
      posts = [];
      savePosts(posts);
      renderPosts(posts);
      renderGanttChart(posts);
    });
  }
}

document.addEventListener("DOMContentLoaded", initApp);
