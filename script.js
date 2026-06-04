const images = ['images/11.png', 'images/12.png', 'images/13.png'];

const reviews = [
    {
        title: '소수정예 관리의 정석',
        text: 'VOD 강의라고 해서 방치되지 않습니다. 주기적인 피드백과 과제 관리가 대면 강의 이상의 긴장감을 줍니다. 연고대 편입을 원한다면 유일한 선택지입니다.',
        reviewer: 'REVIEW BY 정*아 수강생'
    },
    {
        title: '연세대학교 사회학과 최종 합격',
        text: '논술의 기초부터 심화까지 도크티처만의 체계적인 커리큘럼 덕분에 비전공자임에도 불구하고 당당히 합격할 수 있었습니다. 특히 1:1 VOD 관리 시스템이 큰 도움이 되었습니다.',
        reviewer: 'REVIEW BY 김*현 수강생'
    },
    {
        title: '고려대학교 행정학과 편입 합격',
        text: '막막했던 편입 논술의 길을 밝혀주셨습니다. 단순한 글쓰기가 아니라 논리적 사고를 확장하는 법을 배웠습니다. 결과로 증명한다는 말이 무엇인지 체감했습니다.',
        reviewer: 'REVIEW BY 이*우 수강생'
    },
    {
        title: '연세대학교 경영학부 합격 후기',
        text: '교재의 퀄리티가 압도적입니다. 시중의 어떤 교안보다 분석적이고 날카롭습니다. 도크티처의 논리 구조를 내면화하니 어떤 주제가 나와도 당황하지 않게 되었습니다.',
        reviewer: 'REVIEW BY 박*민 수강생'
    },
    {
        title: '한양대학교 법학과 편입 합격',
        text: '처음에는 반신반의했지만 합격 후 확신이 생겼습니다. 논술의 구조화 방법이 명확하고 실전 연습량이 탄탄합니다. 시험장에서 당황하지 않을 수 있었던 건 순전히 도크티처 덕분입니다.',
        reviewer: 'REVIEW BY 최*준 수강생'
    },
    {
        title: '성균관대학교 경제학과 편입 합격',
        text: '관리형 시스템이 정말 강점입니다. 스스로 공부하다 보면 놓치기 쉬운 부분을 코치가 짚어주고 교정해줍니다. 혼자였다면 절대 합격하지 못했을 것 같습니다.',
        reviewer: 'REVIEW BY 오*진 수강생'
    },
    {
        title: '고려대학교 미디어학부 편입 합격',
        text: '논술이 두려웠던 저도 도크티처와 함께하니 자신감이 생겼습니다. 단계별 커리큘럼이 체계적이라 기초부터 탄탄하게 쌓을 수 있었습니다.',
        reviewer: 'REVIEW BY 황*서 수강생'
    },
    {
        title: '연세대학교 심리학과 편입 합격',
        text: '1:1 피드백 시스템이 정말 효과적입니다. 제 글의 약점을 정확히 파악하고 개선 방향을 제시해주셨습니다. 합격 후에도 배운 논리 사고방식이 큰 자산이 되고 있습니다.',
        reviewer: 'REVIEW BY 장*유 수강생'
    },
];

function cardHTML(r, index) {
    const img = images[index % images.length];
    return `
        <div class="card">
            <img class="card-image" src="${img}" alt="${r.title}">
        </div>`;
}

const reviewData = [
    {
        name: "김**", date: "5달 전", rating: 5,
        review: "다시 생각해보아도 1~2월에 들었던 독편논의 논술 독해 강의가 성적 향상에 가장 큰 도움이 되었던 것 같습니다. 수업과 피드백을 통해 편입 논술 지문을 바라보는 시각이 완전히 바뀌었고, 긴 지문에서도 핵심 논지를 빠르게 파악하는 능력이 크게 향상되었습니다. 덕분에 이후에는 논술 공부 시간을 효율적으로 활용할 수 있었고, 결과적으로 목표 대학 편입 합격에 큰 도움이 되었습니다."
    },
    {
        name: "안**", date: "5달 전", rating: 5,
        review: "독편논 논술 클래스가 정말 좋았습니다. 개인적으로는 처음에 내용을 완벽하게 소화하지는 못했지만, 논술을 바라보는 새로운 시각을 갖게 해준 강의였습니다. 이전에는 지문을 단순 암기하거나 감으로 접근했는데, 이제는 논리 구조를 이해하며 읽을 수 있게 되었습니다. 무엇보다 꼼꼼한 관리와 피드백이 큰 도움이 되었습니다."
    },
    {
        name: "안**", date: "5달 전", rating: 5,
        review: "처음에는 논술 실력이 많이 부족했지만, 독편논의 구문·독해 강의를 들으면서 논술에 눈을 뜨게 되었습니다. 꾸준히 자료를 복습하고 기출문제를 반복 학습한 결과, 모의 논술 점수가 눈에 띄게 상승했습니다. 마지막까지 포기하지 않고 따라간 것이 좋은 결과로 이어졌습니다."
    },
    {
        name: "김**", date: "10달 전", rating: 5,
        review: "지금은 독편논에서 배운 독해법이 너무 자연스러워져서 원래 제가 이렇게 읽었는지, 강의를 들으면서 바뀐 것인지 구분이 안 될 정도입니다. 논술 지문을 읽을 때 핵심 논지를 파악하는 과정이 훨씬 익숙해졌습니다."
    },
    {
        name: "정**", date: "9달 전", rating: 5,
        review: "모든 문제를 답에 대한 확신을 가지고 풀고도 시간을 남긴 것은 처음이었습니다. 논술 시험에서도 끝까지 침착하게 작성할 수 있었고, 이전과 비교할 수 없을 정도로 자신감이 생겼습니다."
    },
    {
        name: "이**", date: "7달 전", rating: 5,
        review: "요즘은 지문을 읽으면서 같은 주장이 반복되는 구조가 보이고, 필자가 전달하려는 핵심 논지를 점점 더 정확하게 파악할 수 있게 되었습니다. 독편논에서 배운 독해 방식의 효과를 확실히 체감하고 있습니다."
    },
    {
        name: "전**", date: "4달 전", rating: 5,
        review: "강의를 듣기 전과 비교하면 지문을 읽는 속도가 정말 많이 빨라졌습니다. 점수 향상도 있었지만 그보다 더 크게 느껴지는 것은 문제를 접근하고 해결하는 과정 자체가 달라졌다는 점입니다. 다른 강의만으로는 해결되지 않았던 부분들을 독편논에서 해결할 수 있었습니다."
    },
    {
        name: "이**", date: "4달 전", rating: 5,
        review: "독편논 강의를 수강한 뒤 논술 실력이 크게 향상되었습니다. 공부한 시간 대비 결과가 좋아서 만족도가 높았고, 특히 지문 분석 능력과 답안 작성 능력이 눈에 띄게 발전한 것 같습니다. 목표 대학 편입 준비에 큰 도움이 되었습니다."
    }
];

function reviewCardHTML(r) {
    const stars = '★'.repeat(r.rating) + '☆'.repeat(5 - r.rating);
    return `
        <div class="review-card">
            <div class="review-stars">${[...stars].map(s => `<span>${s}</span>`).join('')}</div>
            <div class="review-meta">
                <span class="review-name">${r.name}</span>
                <span class="review-date">${r.date}</span>
            </div>
            <p class="review-text">${r.review}</p>
        </div>`;
}

function renderReviews() {
    const track = document.getElementById('reviewsTrack');
    if (!track) return;
    const html = reviewData.map(reviewCardHTML).join('');
    track.innerHTML = html + html;
}

function renderCards() {
    const track = document.getElementById('cardsTrack');
    if (!track) return;
    const html = reviews.map((r, i) => cardHTML(r, i)).join('');
    track.innerHTML = html + html;
}

function initHamburger() {
    const btn = document.getElementById('hamburger');
    const menu = document.getElementById('mobileMenu');
    if (!btn || !menu) return;

    btn.addEventListener('click', () => {
        const open = menu.classList.toggle('open');
        btn.setAttribute('aria-expanded', open);
        const spans = btn.querySelectorAll('span');
        spans[0].style.transform = open ? 'translateY(6px) rotate(45deg)' : '';
        spans[1].style.opacity  = open ? '0' : '';
        spans[2].style.transform = open ? 'translateY(-6px) rotate(-45deg)' : '';
    });

    menu.querySelectorAll('a').forEach(a => {
        a.addEventListener('click', () => {
            menu.classList.remove('open');
            btn.querySelectorAll('span').forEach(s => {
                s.style.transform = '';
                s.style.opacity = '';
            });
        });
    });
}

const faqData = [
    {
        question: "현강과 온라인 인강은 어떤 차이가 있나요?",
        answer: "독편논 온라인 과정은 단순히 현장 강의를 촬영한 영상 인강이 아닙니다. 현강 수강이 어려운 지방 거주자, 군인, 직장인, 늦게 시작한 수험생들도 독편논의 핵심 커리큘럼을 체계적으로 따라올 수 있도록 온라인 환경에 맞춰 설계한 과정입니다. 강의 영상뿐 아니라 기출 분석, 학습 자료, 첨삭 시스템, 편입 정보까지 함께 제공되며 필요한 영역만 선택해 수강할 수 있습니다."
    },
    {
        question: "일반 편입논술 인강과 무엇이 다른가요?",
        answer: "독편논 온라인 과정은 단순 기출 해설 중심의 인강이 아니라 제시문 독해, 논제 분석, 답안 구조 설계, 첨삭과 재작성까지 이어지는 합격 시스템을 기반으로 구성되어 있습니다. 특히 논술에서 가장 중요한 사고 과정과 답안 구조를 반복적으로 훈련할 수 있도록 설계되어 있으며, 실제 첨삭을 통해 자신의 답안을 직접 수정하고 보완할 수 있다는 점이 큰 차별점입니다."
    },
    {
        question: "첨삭도 받을 수 있나요?",
        answer: "가능합니다. 독편논 온라인 과정은 단순히 영상을 시청하는 인강이 아니라 직접 답안을 작성하고 피드백을 받으며 개선하는 과정까지 포함하고 있습니다. 논제 이해, 제시문 해석, 답안 구조, 문장 표현 등 실제 시험에서 중요한 요소들을 기준으로 첨삭이 진행되며 Before/After 방식으로 자신의 답안이 어떻게 발전하는지 확인할 수 있습니다."
    },
    {
        question: "늦게 시작한 수강생도 들을 수 있나요?",
        answer: "네. 실제로 늦게 시작한 수험생, 직장인, 군인, 지방 거주자들의 요청이 많아 온라인 과정이 제작되었습니다. 독편논 온라인 과정은 현재 실력과 부족한 영역에 따라 독해, 배경지식, 기출분석, 예상문제, 첨삭 과정 등을 선택해 수강할 수 있도록 구성되어 있어 처음 시작하는 수강생도 단계적으로 따라올 수 있습니다."
    },
    {
        question: "독편논 정회원 혜택이 있나요?",
        answer: "온라인 과정 수강생에게도 독편논 정회원 혜택이 제공됩니다. 자소서, 원서상담, 모의고사 등 독편논의 주요 프로그램에 참여할 수 있으며 온라인 수강생도 현강과 연결된 시스템 안에서 편입 준비를 이어갈 수 있도록 구성되어 있습니다."
    }
];

function renderFaq() {
    const list = document.getElementById('faqList');
    if (!list) return;
    list.innerHTML = faqData.map((item, i) => `
        <div class="faq-item" data-index="${i}">
            <button class="faq-question">
                <span class="faq-question-text">${item.question}</span>
                <span class="faq-icon"></span>
            </button>
            <div class="faq-answer">
                <div class="faq-answer-inner">
                    <p>${item.answer}</p>
                </div>
            </div>
        </div>
    `).join('');

    list.querySelectorAll('.faq-question').forEach(btn => {
        btn.addEventListener('click', () => {
            const item = btn.closest('.faq-item');
            const isOpen = item.classList.contains('open');
            list.querySelectorAll('.faq-item').forEach(el => el.classList.remove('open'));
            if (!isOpen) item.classList.add('open');
        });
    });
}

function doLogin() {
    document.querySelector('.btn-login').style.display = 'none';
    document.getElementById('userMenu').style.display = 'block';
}

function doLogout() {
    document.getElementById('userMenu').style.display = 'none';
    document.querySelector('.btn-login').style.display = '';
}

document.addEventListener('DOMContentLoaded', () => {
    renderReviews();
    renderCards();
    renderFaq();
    initHamburger();
});
