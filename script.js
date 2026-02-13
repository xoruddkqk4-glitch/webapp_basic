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
  updateDoc,
  getDoc,
  deleteField,
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
 * @param {string} type - 'add' | 'delete' | 'edit'
 * @param {object} postData - 게시물 데이터
 */
async function sendEmailNotification(type, postData) {
  if (!emailConfig || !emailConfig.notificationEmail || !window.emailjs) {
    console.log("이메일 알림을 보낼 수 없는 상태입니다 (설정 누락 등).");
    return;
  }

  let actionTypeText = "등록";
  if (type === "delete") actionTypeText = "삭제";
  else if (type === "edit") actionTypeText = "수정";

  const templateParams = {
    email: emailConfig.notificationEmail,
    action_type: actionTypeText,
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

// 첨부파일 최대 크기 (10MB)
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

// 게시 기간 목록 정렬 상태: { by: 'startDate'|'endDate'|null, order: 'asc'|'desc' }
let listSort = { by: null, order: "asc" };

/**
 * 서울 시간대 기준 오늘 날짜 반환 (UTC 기준 00:00:00으로 설정)
 */
function getSeoulToday() {
  const now = new Date();
  // 서울 시간대의 현재 날짜 구성 요소 가져오기
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateStr = formatter.format(now); // YYYY-MM-DD 형식
  
  // parseDateInSeoul과 동일한 방식으로 파싱
  return parseDateInSeoul(dateStr);
}

/**
 * 서울 시간대 기준 현재 날짜 문자열 반환 (YYYY-MM-DD)
 */
function getSeoulTodayString() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return formatter.format(now); // YYYY-MM-DD
}

/**
 * YYYY-MM-DD 형식의 날짜 문자열을 UTC 기준 00:00:00 Date 객체로 변환
 * 모든 날짜를 UTC 기준으로 통일하여 정확한 비교가 가능하도록 함
 */
function parseDateInSeoul(dateString) {
  if (!dateString) return null;
  // YYYY-MM-DD를 UTC 00:00:00으로 파싱
  const [year, month, day] = dateString.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  return date;
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

  const s = parseDateInSeoul(startDate);
  const e = parseDateInSeoul(endDate);

  if (today < s) {
    return { code: "pending", label: "게시 예정" };
  }
  if (today > e) {
    return { code: "expired", label: "게시 종료" };
  }
  return { code: "active", label: "게시 중" };
}

/**
 * 단일 게시물 DOM 요소 생성 (가로형 목록용: 제목 | 부서 | 담당자 | 시작일 | 종료일 | 상태 | 첨부파일 | 수정 | 삭제)
 */
function createPostElement(post, index, onEdit, onDelete) {
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
  if (post.attachment && post.attachment.downloadURL && post.attachment.fileName) {
    const a = document.createElement("a");
    a.href = "#";
    a.className = "btn-download";
    a.textContent = "다운로드";
    // 클릭 시 강제 다운로드
    a.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        const response = await fetch(post.attachment.downloadURL);
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = post.attachment.fileName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
      } catch (error) {
        console.error("다운로드 실패:", error);
        // 실패 시 원본 URL로 다운로드 시도
        window.open(post.attachment.downloadURL, "_blank");
      }
    });
    attCell.appendChild(a);
  } else {
    attCell.textContent = "-";
    attCell.style.color = "#9ca3af";
  }

  const actionsCell = document.createElement("div");
  actionsCell.className = "post-actions";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "post-edit";
  editBtn.title = "수정";
  editBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
  </svg>`;
  editBtn.addEventListener("click", () => onEdit(index));

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "post-delete";
  deleteBtn.title = "삭제";
  deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2">
    <path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
  </svg>`;
  deleteBtn.addEventListener("click", () => onDelete(index));

  actionsCell.appendChild(editBtn);
  actionsCell.appendChild(deleteBtn);

  container.appendChild(department);
  container.appendChild(personInCharge);
  container.appendChild(title);
  container.appendChild(startDateEl);
  container.appendChild(endDateEl);
  container.appendChild(statusSpan);
  container.appendChild(attCell);
  container.appendChild(actionsCell);

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
  header.innerHTML = "<span>부서</span><span>담당자</span><span>제목</span><span></span><span></span><span>상태</span><span>첨부파일</span><span>작업</span>";

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
      // 수정 버튼 클릭
      const target = displayPosts[idx];
      if (!target || !target.id) return;
      openEditModal(target);
    }, async (idx) => {
      // 삭제 버튼 클릭
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
      const d = parseDateInSeoul(p.startDate);
      if (min === null || d < min) min = d;
    }
    if (p.endDate) {
      const d = parseDateInSeoul(p.endDate);
      if (max === null || d > max) max = d;
    }
  });
  if (min === null || max === null || min > max) return null;
  
  // 패딩 계산 (5% 또는 최소 7일)
  const pad = (max - min) * 0.05 || 86400000 * 7;
  
  // 패딩이 추가된 날짜를 UTC 00:00:00으로 정규화
  const paddedMin = new Date(min.getTime() - pad);
  paddedMin.setUTCHours(0, 0, 0, 0);
  
  const paddedMax = new Date(max.getTime() + pad);
  paddedMax.setUTCHours(0, 0, 0, 0);
  
  return { 
    min: paddedMin, 
    max: paddedMax,
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
  const todayMs = today.getTime();
  const rangeMinMs = range.min.getTime();
  const rangeMaxMs = range.max.getTime();
  
  // 오늘 날짜의 시작 위치 계산
  let todayPct;
  if (todayMs < rangeMinMs) {
    todayPct = 0;
  } else if (todayMs > rangeMaxMs) {
    todayPct = 100;
  } else {
    todayPct = ((todayMs - rangeMinMs) / totalMs) * 100;
  }
  todayPct = Math.max(0, Math.min(100, todayPct));
  
  // 하루의 너비를 퍼센트로 계산 (86400000ms = 1일)
  const oneDayMs = 86400000;
  const todayWidthPct = (oneDayMs / totalMs) * 100;
  
  const todayStr = getSeoulTodayString();
  el.style.setProperty("--today-pct", String(todayPct));
  el.style.setProperty("--today-width-pct", String(todayWidthPct));

  const header = document.createElement("div");
  header.className = "gantt-timeline-header";

  const labelHeader = document.createElement("div");
  labelHeader.className = "gantt-label-header";
  labelHeader.textContent = "제목";

  const datesHeader = document.createElement("div");
  datesHeader.className = "gantt-dates-header";
  
  // 시작월과 종료월 계산
  const minDate = new Date(range.actualMin);
  const maxDate = new Date(range.actualMax);
  
  // YYYY-MM 형식으로 변환
  const startMonthStr = `${minDate.getFullYear()}-${String(minDate.getMonth() + 1).padStart(2, '0')}`;
  const endMonthStr = `${maxDate.getFullYear()}-${String(maxDate.getMonth() + 1).padStart(2, '0')}`;
  
  datesHeader.innerHTML = "";
  const datesLabelStart = document.createElement("span");
  datesLabelStart.className = "gantt-header-date";
  datesLabelStart.textContent = "시작달 " + startMonthStr;
  const datesLabelEnd = document.createElement("span");
  datesLabelEnd.className = "gantt-header-date";
  datesLabelEnd.textContent = "종료달 " + endMonthStr;
  datesHeader.appendChild(datesLabelStart);
  datesHeader.appendChild(datesLabelEnd);

  header.appendChild(labelHeader);
  header.appendChild(datesHeader);
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "gantt-timeline-body";
  body.style.setProperty("--today-pct", String(todayPct));
  body.style.setProperty("--today-width-pct", String(todayWidthPct));

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

    const start = parseDateInSeoul(post.startDate).getTime();
    const end = parseDateInSeoul(post.endDate).getTime();
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
  todayCaptionWrap.style.setProperty("--today-pct", String(todayPct));
  todayCaptionWrap.style.setProperty("--today-width-pct", String(todayWidthPct));
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
  const editModal = document.getElementById("edit-modal");
  const editForm = document.getElementById("edit-form");
  const modalClose = document.getElementById("modal-close");
  const cancelEdit = document.getElementById("cancel-edit");
  const helpBtn = document.getElementById("help-btn");
  const helpModal = document.getElementById("help-modal");
  const helpModalClose = document.getElementById("help-modal-close");

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

    const submitBtn = form.querySelector('button[type="submit"]');
    const originalBtnText = submitBtn.textContent;

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

    // 저장 중 표시
    submitBtn.disabled = true;
    submitBtn.textContent = "저장 중...";
    submitBtn.style.opacity = "0.7";

    let attachmentMeta = null;
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      if (file.size > MAX_ATTACHMENT_SIZE) {
        alert("첨부파일은 최대 10MB까지 가능합니다.");
        // 버튼 복구
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        submitBtn.style.opacity = "1";
        return;
      }
      try {
        attachmentMeta = await uploadAttachmentToStorage(file);
      } catch (e) {
        console.error(e);
        alert("첨부파일을 업로드하는 중 오류가 발생했습니다.");
        // 버튼 복구
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        submitBtn.style.opacity = "1";
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

      // 버튼 복구
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
      submitBtn.style.opacity = "1";
    } catch (e) {
      console.error("Failed to add post to Firestore", e);
      alert("게시물 저장 중 오류가 발생했습니다.");
      // 버튼 복구
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
      submitBtn.style.opacity = "1";
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

  // 모달 닫기
  const closeModal = () => {
    editModal.classList.remove("show");
  };

  modalClose.addEventListener("click", closeModal);
  cancelEdit.addEventListener("click", closeModal);
  editModal.addEventListener("click", (e) => {
    if (e.target === editModal) closeModal();
  });

  // 수정 폼 제출
  editForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    await handleEditSubmit();
  });

  // 사용법 모달
  if (helpBtn && helpModal) {
    helpBtn.addEventListener("click", async () => {
      helpModal.classList.add("show");
      const helpContent = document.getElementById("help-content");
      
      try {
        const response = await fetch("README.md");
        const markdownText = await response.text();
        
        // marked.js를 사용하여 마크다운을 HTML로 변환
        if (typeof marked !== "undefined") {
          helpContent.innerHTML = marked.parse(markdownText);
        } else {
          // marked.js가 로드되지 않은 경우 원본 텍스트 표시
          helpContent.innerHTML = `<pre>${markdownText}</pre>`;
        }
      } catch (e) {
        console.error("Failed to load README", e);
        helpContent.innerHTML = "<p>사용법을 불러올 수 없습니다.</p>";
      }
    });

    const closeHelpModal = () => {
      helpModal.classList.remove("show");
    };

    helpModalClose.addEventListener("click", closeHelpModal);
    helpModal.addEventListener("click", (e) => {
      if (e.target === helpModal) closeHelpModal();
    });
  }
}

/**
 * 수정 모달 열기
 */
function openEditModal(post) {
  const modal = document.getElementById("edit-modal");
  const form = document.getElementById("edit-form");
  
  // 폼에 기존 데이터 채우기
  form.querySelector("#edit-id").value = post.id;
  form.querySelector("#edit-department").value = post.department || "";
  form.querySelector("#edit-personInCharge").value = post.personInCharge || "";
  form.querySelector("#edit-title").value = post.title || "";
  form.querySelector("#edit-startDate").value = post.startDate || "";
  form.querySelector("#edit-endDate").value = post.endDate || "";
  
  // 첨부파일 정보 표시
  const currentFileInfo = document.getElementById("current-file-info");
  const fileInput = form.querySelector("#edit-attachment");
  fileInput.value = ""; // 파일 입력 초기화
  
  if (post.attachment && post.attachment.fileName) {
    currentFileInfo.innerHTML = `
      <span class="current-file-name">${post.attachment.fileName}</span>
      <button type="button" class="btn-remove-file" id="remove-file-btn">파일 삭제</button>
    `;
    currentFileInfo.classList.add("show");
    
    // 파일 삭제 버튼 이벤트
    document.getElementById("remove-file-btn").addEventListener("click", () => {
      currentFileInfo.classList.remove("show");
      currentFileInfo.innerHTML = "";
      form.dataset.removeFile = "true";
    });
  } else {
    currentFileInfo.classList.remove("show");
    currentFileInfo.innerHTML = "";
  }
  
  delete form.dataset.removeFile;
  modal.classList.add("show");
}

/**
 * 수정 폼 제출 처리
 */
async function handleEditSubmit() {
  const form = document.getElementById("edit-form");
  const modal = document.getElementById("edit-modal");
  const submitBtn = form.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn.textContent;
  
  const postId = form.querySelector("#edit-id").value;
  const department = form.querySelector("#edit-department").value.trim();
  const personInCharge = form.querySelector("#edit-personInCharge").value.trim();
  const title = form.querySelector("#edit-title").value.trim();
  const startDate = form.querySelector("#edit-startDate").value;
  const endDate = form.querySelector("#edit-endDate").value;
  const fileInput = form.querySelector("#edit-attachment");
  
  if (!department || !personInCharge || !title || !startDate || !endDate) {
    alert("부서, 담당자, 제목, 게시 시작일, 게시 종료일은 필수입니다.");
    return;
  }

  if (endDate < startDate) {
    alert("게시 종료일은 게시 시작일보다 빠를 수 없습니다.");
    return;
  }

  try {
    // 저장 중 표시
    submitBtn.disabled = true;
    submitBtn.textContent = "저장 중...";
    submitBtn.style.opacity = "0.7";
    
    const postRef = doc(db, "posts", postId);
    const postSnap = await getDoc(postRef);
    
    if (!postSnap.exists()) {
      alert("게시물을 찾을 수 없습니다.");
      submitBtn.disabled = false;
      submitBtn.textContent = originalBtnText;
      submitBtn.style.opacity = "1";
      return;
    }
    
    const currentPost = postSnap.data();
    let attachmentMeta = currentPost.attachment || null;
    
    // 파일 삭제 요청이 있으면 기존 파일 삭제
    if (form.dataset.removeFile === "true") {
      if (attachmentMeta && attachmentMeta.storagePath) {
        try {
          await deleteObject(ref(storage, attachmentMeta.storagePath));
        } catch (e) {
          console.warn("Failed to delete old attachment", e);
        }
      }
      attachmentMeta = null;
    }
    
    // 새 파일 업로드
    if (fileInput && fileInput.files && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      if (file.size > MAX_ATTACHMENT_SIZE) {
        alert("첨부파일은 최대 10MB까지 가능합니다.");
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        submitBtn.style.opacity = "1";
        return;
      }
      
      // 기존 파일이 있으면 삭제
      if (attachmentMeta && attachmentMeta.storagePath) {
        try {
          await deleteObject(ref(storage, attachmentMeta.storagePath));
        } catch (e) {
          console.warn("Failed to delete old attachment", e);
        }
      }
      
      try {
        attachmentMeta = await uploadAttachmentToStorage(file);
      } catch (e) {
        console.error(e);
        alert("첨부파일을 업로드하는 중 오류가 발생했습니다.");
        submitBtn.disabled = false;
        submitBtn.textContent = originalBtnText;
        submitBtn.style.opacity = "1";
        return;
      }
    }
    
    // Firestore 업데이트
    const updateData = {
      department,
      personInCharge,
      title,
      startDate,
      endDate,
    };
    
    // attachment 처리: null이면 필드 삭제, 값이 있으면 업데이트
    if (attachmentMeta === null) {
      updateData.attachment = deleteField();
    } else {
      updateData.attachment = attachmentMeta;
    }
    
    await updateDoc(postRef, updateData);
    
    // 이메일 알림
    sendEmailNotification("edit", { department, personInCharge, title }).catch(console.error);
    
    // 목록 새로고침
    const posts = await loadPosts();
    renderPosts(posts);
    
    // 모달 닫기
    modal.classList.remove("show");
    
    // 버튼 복구
    submitBtn.disabled = false;
    submitBtn.textContent = originalBtnText;
    submitBtn.style.opacity = "1";
    
  } catch (e) {
    console.error("Failed to update post", e);
    alert("게시물 수정 중 오류가 발생했습니다.");
    submitBtn.disabled = false;
    submitBtn.textContent = originalBtnText;
    submitBtn.style.opacity = "1";
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initApp().catch(console.error);
});
