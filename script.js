// ---------------- Firebase import & 초기화 ----------------
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.3/firebase-app.js";
import {
  getFirestore,
  collection,
  getDocs,
  addDoc,
  deleteDoc,
  doc,
  serverTimestamp,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-firestore.js";
import {
  getStorage,
  ref,
  uploadBytes,
  getDownloadURL,
  deleteObject,
} from "https://www.gstatic.com/firebasejs/10.12.3/firebase-storage.js";

// 👉 firebaseConfig는 Firebase 콘솔에서 가져온 값으로 교체하세요
const firebaseConfig = {
  apiKey: "AIzaSyBnvH3PKD-uWOCRLQG8jTxD8iVJf0UwbPY",
  authDomain: "did-display.firebaseapp.com",
  projectId: "did-display",
  storageBucket: "did-display.firebasestorage.app",
  messagingSenderId: "316039230196",
  appId: "1:316039230196:web:13536611ab408672c724a1",
  measurementId: "G-QJYFEVKZ2N"
};

const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
const storage = getStorage(firebaseApp);

// Firestore 컬렉션 참조
const postsCollection = collection(db, "posts");

// ---------------------------------------------------------

/**
 * 이메일 설정 로드 및 초기화
 */
let emailConfig = null;

async function loadEmailConfig() {
  try {
    const response = await fetch("email_config.json");
    if (!response.ok) throw new Error("Config load failed");
    emailConfig = await response.json();

    if (emailConfig && emailConfig.emailjs && window.emailjs) {
      emailjs.init(emailConfig.emailjs.publicKey);
      console.log("EmailJS initialized");
    }
  } catch (e) {
    console.warn("이메일 설정을 불러오지 못했습니다.", e);
  }
}

/**
 * 이메일 알림 발송 함수
 * @param {string} type - 'add' | 'delete'
 * @param {object} postData - 게시물 데이터
 */
async function sendEmailNotification(type, postData) {
  if (!emailConfig || !emailConfig.notificationEmail || !window.emailjs) {
    console.log("이메일 알림을 보낼 수 없는 상태입니다 (설정 누락 등).");
    return;
  }

  const templateParams = {
    email: emailConfig.notificationEmail,
    action_type: type === "add" ? "등록" : "삭제",
    department: postData.department || "-",
    title: postData.title || "-",
    person: postData.personInCharge || "-",
    date: new Date().toLocaleString("ko-KR", { timeZone: "Asia/Seoul" }),
  };

  try {
    console.log(`Sending email to ${emailConfig.notificationEmail}...`, templateParams);
    // 실제 발송: 서비스 ID, 템플릿 ID는 config에서 가져옴
    await emailjs.send(
      emailConfig.emailjs.serviceId,
      emailConfig.emailjs.templateId,
      templateParams
    );
    console.log("Email sent successfully!");
  } catch (e) {
    console.error("Email sending failed", e);
  }
}

// 첨부파일 최대 크기 (2MB)
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024;

// 게시 기간 목록 정렬 상태: { by: 'startDate'|'endDate'|null, order: 'asc'|'desc' }
let listSort = { by: null, order: "asc" };

/**
 * 서울 시간대 기준 오늘 날짜 반환 (시/분/초는 00:00:00으로 설정)
 */
function getSeoulToday() {
  const now = new Date();
  // 서울 시간대로 변환 (UTC+9)
  const seoulTime = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }));
  seoulTime.setHours(0, 0, 0, 0);
  return seoulTime;
}

/**
 * 서울 시간대 기준 현재 날짜 문자열 반환 (YYYY-MM-DD)
 */
function getSeoulTodayString() {
  const now = new Date();
  // 서울 시간대로 변환하여 YYYY-MM-DD 형식으로 반환
  return new Date(now.toLocaleString("en-US", { timeZone: "Asia/Seoul" }))
    .toISOString()
    .slice(0, 10);
}

/**
 * 저장된 게시물 목록 불러오기 (Cloud Firestore)
 */
async function loadPosts() {
  try {
    // createdAt 기준 최신순 정렬
    const q = query(postsCollection, orderBy("createdAt", "desc"));
    const snapshot = await getDocs(q);

    const posts = snapshot.docs.map((docSnap) => ({
      id: docSnap.id,
      ...docSnap.data(),
    }));

    return posts;
  } catch (e) {
    console.error("Failed to load posts from Firestore", e);
    return [];
  }
}

/**
 * 파일을 Firebase Storage에 업로드하고 메타 정보 반환
 */
async function uploadAttachmentToStorage(file) {
  const storagePath = `attachments/${Date.now()}-${file.name}`;
  const fileRef = ref(storage, storagePath);

  await uploadBytes(fileRef, file);
  const downloadURL = await getDownloadURL(fileRef);

  return {
    fileName: file.name,
    mimeType: file.type || "application/octet-stream",
    storagePath,
    downloadURL,
  };
}

/**
 * 게시 상태 계산 (예: 진행중, 예정, 종료)
 */
function getPostStatus(startDate, endDate) {
  if (!startDate || !endDate) return { code: "unknown", label: "기간 미설정" };
  const today = getSeoulToday();

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
  if (post.attachment && post.attachment.downloadURL) {
    const a = document.createElement("a");
    a.href = post.attachment.downloadURL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
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
    const item = createPostElement(post, index, async (idx) => {
      const target = displayPosts[idx];
      if (!target || !target.id) return;

      if (!confirm("이 게시물을 삭제하시겠습니까?")) return;

      try {
        // Firestore 문서 삭제
        await deleteDoc(doc(db, "posts", target.id));

        // 이메일 알림 발송
        sendEmailNotification("delete", target).catch(console.error);
        // Storage 첨부파일 삭제 (있다면)
        if (target.attachment && target.attachment.storagePath) {
          try {
            await deleteObject(ref(storage, target.attachment.storagePath));
          } catch (e) {
            console.warn("Failed to delete attachment from storage", e);
          }
        }

        const newPosts = await loadPosts();
        renderPosts(newPosts);
      } catch (e) {
        console.error("Failed to delete post", e);
        alert("삭제 중 오류가 발생했습니다.");
      }
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
  return { 
    min: new Date(min.getTime() - pad), 
    max: new Date(max.getTime() + pad),
    actualMin: min,  // 실제 게시물 최소 시작일
    actualMax: max   // 실제 게시물 최대 종료일
  };
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
  const today = getSeoulToday();
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
  const todayStr = getSeoulTodayString();
  el.style.setProperty("--today-pct", String(todayPct));

  const header = document.createElement("div");
  header.className = "gantt-timeline-header";

  const labelHeader = document.createElement("div");
  labelHeader.className = "gantt-label-header";
  labelHeader.textContent = "제목";

  const datesHeader = document.createElement("div");
  datesHeader.className = "gantt-dates-header";
  // 실제 게시물의 시작일/종료일 표시 (패딩이 추가되지 않은 날짜)
  const startStr = range.actualMin.toISOString().slice(0, 10);
  const endStr = range.actualMax.toISOString().slice(0, 10);
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
async function initApp() {
  const form = document.getElementById("post-form");
  const clearAllBtn = document.getElementById("clear-all");

  if (!form) return;

  // 서울 시간대 기준 오늘 날짜를 기본값으로 설정
  const startInput = document.getElementById("startDate");
  const endInput = document.getElementById("endDate");
  const todayStr = getSeoulTodayString();
  if (startInput && !startInput.value) startInput.value = todayStr;
  if (endInput && !endInput.value) endInput.value = todayStr;

  // 이메일 설정 로드
  await loadEmailConfig();
  // 기존 게시물 렌더링 (Firestore에서 비동기 로드)
  let posts = await loadPosts();
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

    let attachmentMeta = null;
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      if (file.size > MAX_ATTACHMENT_SIZE) {
        alert("첨부파일은 최대 2MB까지 가능합니다.");
        return;
      }
      try {
        attachmentMeta = await uploadAttachmentToStorage(file);
      } catch (e) {
        console.error(e);
        alert("첨부파일을 업로드하는 중 오류가 발생했습니다.");
        return;
      }
    }

    try {
      await addDoc(postsCollection, {
        department,
        personInCharge,
        title,
        startDate,
        endDate,
        createdAt: serverTimestamp(),
        attachment: attachmentMeta,
      });

      // 이메일 알림 발송 (비동기 처리, 에러 나도 게시물 등록은 성공으로 간주)
      sendEmailNotification("add", { department, personInCharge, title }).catch(console.error);
      posts = await loadPosts();
      renderPosts(posts);

      form.querySelector("#title").value = "";
      form.querySelector("#department").value = "";
      form.querySelector("#personInCharge").value = "";
      if (fileInput) fileInput.value = "";
    } catch (e) {
      console.error("Failed to add post to Firestore", e);
      alert("게시물 저장 중 오류가 발생했습니다.");
    }
  });

  if (clearAllBtn) {
    clearAllBtn.addEventListener("click", async () => {
      if (!confirm("모든 게시물을 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.")) return;

      try {
        const currentPosts = await loadPosts();

        for (const p of currentPosts) {
          if (!p.id) continue;
          await deleteDoc(doc(db, "posts", p.id));
          if (p.attachment && p.attachment.storagePath) {
            try {
              await deleteObject(ref(storage, p.attachment.storagePath));
            } catch (e) {
              console.warn("Failed to delete attachment from storage", e);
            }
          }
        }

        const empty = [];
        renderPosts(empty);
        renderGanttChart(empty);
      } catch (e) {
        console.error("Failed to clear all posts", e);
        alert("전체 삭제 중 오류가 발생했습니다.");
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initApp().catch(console.error);
});
