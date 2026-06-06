(function () {
    const groupDataElement = document.getElementById('groupRosterData');
    const groupRosterData = groupDataElement ? JSON.parse(groupDataElement.textContent || '[]') : [];

    const api = {
        createGroup: '/api/create-group',
        qrPayload: '/api/group-qr-payload',
        scanInvite: '/api/scan-invite',
        pendingInvites: '/api/pending-invites',
        leaveGroup: '/api/leave-group',
        removeGroupMember: '/api/remove-group-member',
        acceptInvite: (inviteId) => `/api/accept-invite/${inviteId}`,
        declineInvite: (inviteId) => `/api/decline-invite/${inviteId}`
    };

    let activeGroupId = groupRosterData[0]?.group?.id || null;
    let leaderboardSort = document.getElementById('leaderboardSort')?.value || 'desc';
    let scanStream = null;
    let scanLoopId = null;
    let isScanning = false;
    let knownInviteIds = new Set(
        Array.from(document.querySelectorAll('[data-invite-id]'))
            .map(card => String(card.dataset.inviteId))
            .filter(Boolean)
    );
    const loadedScripts = new Map();

    function loadScript(src) {
        if (loadedScripts.has(src)) return loadedScripts.get(src);
        const promise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = resolve;
            script.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(script);
        });
        loadedScripts.set(src, promise);
        return promise;
    }

    function openModal(modalId) {
        document.getElementById(modalId).classList.add('active');
    }

    function closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) modal.classList.remove('active');
        if (modalId === 'scanQrModal') stopQrScanner();
    }

    function sortedMembers(members) {
        return [...members].sort((a, b) => {
            const aScore = Number(a.ippt_score?.total_points || a.ippt_points || 0);
            const bScore = Number(b.ippt_score?.total_points || b.ippt_points || 0);
            return leaderboardSort === 'asc' ? aScore - bScore : bScore - aScore;
        });
    }

    function renderRoster(groupId) {
        const leaderboardList = document.getElementById('mobileLeaderboardList');
        activeGroupId = Number(groupId);
        const selected = groupRosterData.find(item => item.group.id === Number(groupId));
        updateGroupSummary(selected);

        if (!selected || selected.members.length === 0) {
            if (leaderboardList) {
                leaderboardList.innerHTML = '<div class="mobile-empty-state">No roster records available for this group yet.</div>';
            }
            return;
        }

        const members = sortedMembers(selected.members);
        if (leaderboardList) {
            leaderboardList.innerHTML = members.map((member, index) => leaderCard(member, index)).join('');
        }
    }

    function updateGroupSummary(selected) {
        const title = document.getElementById('tableTitleContext');
        const count = document.getElementById('groupMemberCount');
        const leaveButton = document.getElementById('leaveGroupButton');
        const scanButton = document.querySelector('[onclick="openQrScanner()"]');

        if (title) title.textContent = selected?.group?.name || 'No group yet';
        if (count) {
            const memberCount = selected?.members?.length || 0;
            count.textContent = `${memberCount} ${memberCount === 1 ? 'member' : 'members'}`;
        }
        if (leaveButton) leaveButton.disabled = !selected;
        if (scanButton) scanButton.disabled = !selected;
    }

    function leaderCard(member, index) {
        const best = member.personal_best || {};
        const score = member.ippt_score || {};
        const award = score.award || {};
        const points = score.total_points ?? member.ippt_points ?? 0;
        const awardCode = award.code || 'fail';
        const awardLabel = award.label || 'Fail';
        const awardIconUrl = awardIcon(awardCode);
        const showAward = !['fail', 'incomplete'].includes(awardCode);
        const hasRankIcon = index < 3;

        return `
            <article class="leader-card leader-card-rank-${index + 1} ${hasRankIcon ? '' : 'no-trophy'}">
                <div class="leader-rank-block">
                    ${hasRankIcon
                        ? `<img class="trophy-icon" src="${rankIcon(index + 1)}" alt="${index + 1} place">`
                        : `<span class="rank-number">${index + 1}</span>`}
                </div>
                <div class="leader-main">
                    <div class="leader-name">
                        <strong>${escapeHtml(displayName(member.name, 'NSman'))}</strong>
                    </div>
                    ${showAward ? `
                    <span class="award-pill ${escapeHtml(awardCode)}">
                        ${awardIconUrl ? `<img src="${awardIconUrl}" alt="">` : ''}
                        ${escapeHtml(awardLabel)}
                    </span>` : ''}
                </div>
                <div class="leader-score">
                    <strong>${escapeHtml(points)}</strong>
                    <span>PTS</span>
                </div>
                <div class="leader-metrics">
                    <div class="leader-metric metric-pushup">
                        <img class="metric-icon" src="/static/icons/greenpushup.png" alt="">
                        <span>PUSH-UP</span>
                        <strong>${escapeHtml(best.pushups || '--')}</strong>
                        <small>reps</small>
                    </div>
                    <div class="leader-metric metric-situp">
                        <img class="metric-icon" src="/static/icons/bluesitup.png" alt="">
                        <span>SIT-UP</span>
                        <strong>${escapeHtml(best.situps || '--')}</strong>
                        <small>reps</small>
                    </div>
                    <div class="leader-metric metric-run">
                        <img class="metric-icon" src="/static/icons/orangerun.png" alt="">
                        <span>RUN</span>
                        <strong>${escapeHtml(best.run_time || '--:--')}</strong>
                        <small>min</small>
                    </div>
                    <div class="leader-metric metric-award award-${escapeHtml(awardCode)}">
                        <span>IPPT</span>
                        <span class="award-pill ${escapeHtml(awardCode)}">
                            ${awardIconUrl ? `<img src="${awardIconUrl}" alt="">` : ''}
                            ${escapeHtml(awardLabel)}
                        </span>
                        <small>status</small>
                    </div>
                </div>
                ${member.can_be_removed ? `
                <div class="member-card-actions">
                    <button class="member-action-button" type="button" onclick="removeGroupMember(${Number(member.id)})" aria-label="Remove ${escapeHtml(displayName(member.name, 'NSman'))}">Remove</button>
                </div>` : ''}
            </article>`;
    }

    function awardIcon(code) {
        if (code === 'gold') return '/static/icons/goldbadge.png';
        if (code === 'silver') return '/static/icons/silverbadge.png';
        if (code === 'pass-incentive') return '/static/icons/passwithincentivebadge.png';
        if (code === 'pass') return '/static/icons/passbadge.png';
        return '';
    }

    function rankIcon(rank) {
        if (rank === 1) return '/static/icons/1stplace.png';
        if (rank === 2) return '/static/icons/2ndplace.png';
        return '/static/icons/3rdplace.png';
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, char => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        }[char]));
    }

    function displayName(value, fallback = 'NSman') {
        const text = String(value || '').trim();
        if (!text || /^[STFG]\d{7}[A-Z]$/i.test(text)) return fallback;
        return text;
    }

    function selectTab(tabElement) {
        if (tabElement.classList.contains('create-group-pill')) return;
        const pills = document.querySelectorAll('.filter-pill:not(.create-group-pill)');
        pills.forEach(p => p.classList.remove('active'));
        tabElement.classList.add('active');
        renderRoster(tabElement.dataset.groupId);
    }

    function setLeaderboardSort(value) {
        leaderboardSort = value === 'asc' ? 'asc' : 'desc';
        const url = new URL(window.location.href);
        url.searchParams.set('sort', leaderboardSort);
        window.history.replaceState({}, '', url.toString());
        if (activeGroupId) {
            renderRoster(activeGroupId);
        }
    }

    function submitCreateGroup() {
        const groupName = document.getElementById('newGroupName').value.trim();
        if (!groupName) {
            alert('Please enter a group name.');
            return;
        }

        fetch(api.createGroup, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ group_name: groupName })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                location.reload();
            } else {
                alert('Error: ' + (data.error || 'Failed to create group'));
            }
        })
        .catch(err => {
            console.error(err);
            alert('Failed to create group');
        });
    }

    async function openMyQr() {
        openModal('myQrModal');
        setQrStatus('myQrStatus', 'Generating QR...', '');
        try {
            const response = await fetch(api.qrPayload);
            const data = await response.json();
            if (!data.success) throw new Error(data.error || 'Could not generate QR');

            await loadScript('/static/js/vendor/qrcode.min.js');
            const target = document.getElementById('myQrCanvas');
            target.innerHTML = '';
            new window.QRCode(target, {
                text: data.payload,
                width: 220,
                height: 220,
                colorDark: '#0F172A',
                colorLight: '#FFFFFF',
                correctLevel: window.QRCode.CorrectLevel.M
            });
            setQrStatus('myQrStatus', `${displayName(data.name, 'Your')} QR is ready.`, 'success');
        } catch (error) {
            console.error(error);
            setQrStatus('myQrStatus', 'QR generator unavailable. Check your connection and try again.', 'error');
        }
    }

    async function openQrScanner() {
        const activeTab = document.querySelector('.filter-pill.active:not(.create-group-pill)');
        if (!activeTab) {
            alert('Create or select a group first.');
            return;
        }
        activeGroupId = Number(activeTab.dataset.groupId);
        openModal('scanQrModal');
        await startQrScanner();
    }

    async function startQrScanner() {
        stopQrScanner();
        const video = document.getElementById('qrScanVideo');
        const canvas = document.getElementById('qrScanCanvas');
        if (!navigator.mediaDevices?.getUserMedia) {
            setQrStatus('scanQrStatus', 'Camera access is not available in this browser.', 'error');
            return;
        }

        try {
            setQrStatus('scanQrStatus', 'Starting camera...', '');
            scanStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
                audio: false
            });
            video.srcObject = scanStream;
            await video.play();
            isScanning = true;
            setQrStatus('scanQrStatus', 'Scanning...', '');

            if ('BarcodeDetector' in window) {
                const detector = new BarcodeDetector({ formats: ['qr_code'] });
                scanWithBarcodeDetector(detector, video);
            } else {
                await loadScript('/static/js/vendor/jsQR.js');
                scanWithJsQr(video, canvas);
            }
        } catch (error) {
            console.error(error);
            setQrStatus('scanQrStatus', 'Camera permission is needed to scan QR codes.', 'error');
            stopQrScanner();
        }
    }

    async function scanWithBarcodeDetector(detector, video) {
        if (!isScanning) return;
        try {
            const codes = await detector.detect(video);
            if (codes.length > 0 && codes[0].rawValue) {
                handleScannedPayload(codes[0].rawValue);
                return;
            }
        } catch (error) {
            console.error(error);
        }
        scanLoopId = requestAnimationFrame(() => scanWithBarcodeDetector(detector, video));
    }

    function scanWithJsQr(video, canvas) {
        if (!isScanning) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (width && height && window.jsQR) {
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext('2d');
            context.drawImage(video, 0, 0, width, height);
            const imageData = context.getImageData(0, 0, width, height);
            const code = window.jsQR(imageData.data, width, height);
            if (code?.data) {
                handleScannedPayload(code.data);
                return;
            }
        }
        scanLoopId = requestAnimationFrame(() => scanWithJsQr(video, canvas));
    }

    function stopQrScanner() {
        isScanning = false;
        if (scanLoopId) {
            cancelAnimationFrame(scanLoopId);
            scanLoopId = null;
        }
        if (scanStream) {
            scanStream.getTracks().forEach(track => track.stop());
            scanStream = null;
        }
        const video = document.getElementById('qrScanVideo');
        if (video) video.srcObject = null;
    }

    function handleScannedPayload(qrPayload) {
        if (!isScanning) return;
        isScanning = false;
        setQrStatus('scanQrStatus', 'Sending invite...', '');

        fetch(api.scanInvite, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                group_id: activeGroupId,
                qr_payload: qrPayload
            })
        })
        .then(res => res.json().then(data => ({ ok: res.ok, data })))
        .then(({ ok, data }) => {
            if (ok && data.success) {
                setQrStatus('scanQrStatus', `Invitation sent to ${displayName(data.recipient_name, 'teammate')}.`, 'success');
                setTimeout(() => closeModal('scanQrModal'), 900);
            } else {
                setQrStatus('scanQrStatus', data.error || 'Could not send invite.', 'error');
                setTimeout(() => {
                    if (document.getElementById('scanQrModal')?.classList.contains('active')) {
                        isScanning = true;
                        const video = document.getElementById('qrScanVideo');
                        if ('BarcodeDetector' in window) {
                            scanWithBarcodeDetector(new BarcodeDetector({ formats: ['qr_code'] }), video);
                        } else {
                            scanWithJsQr(video, document.getElementById('qrScanCanvas'));
                        }
                    }
                }, 1400);
            }
        })
        .catch(err => {
            console.error(err);
            setQrStatus('scanQrStatus', 'Could not send invite.', 'error');
        });
    }

    function setQrStatus(elementId, message, state) {
        const element = document.getElementById(elementId);
        if (!element) return;
        element.textContent = message;
        element.className = `qr-status ${state || ''}`.trim();
    }

    function leaveActiveGroup() {
        if (!activeGroupId) {
            alert('Select a group first.');
            return;
        }
        const selected = groupRosterData.find(item => item.group.id === Number(activeGroupId));
        const groupName = selected?.group?.name || 'this group';
        if (!window.confirm(`Leave ${groupName}?`)) return;

        fetch(api.leaveGroup, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ group_id: Number(activeGroupId) })
        })
        .then(res => res.json().then(data => ({ ok: res.ok, data })))
        .then(({ ok, data }) => {
            if (ok && data.success) {
                location.reload();
            } else {
                alert(data.error || 'Could not leave group.');
            }
        })
        .catch(err => {
            console.error(err);
            alert('Could not leave group.');
        });
    }

    function removeGroupMember(memberId) {
        if (!activeGroupId || !memberId) return;
        const selected = groupRosterData.find(item => item.group.id === Number(activeGroupId));
        const member = selected?.members?.find(item => item.id === Number(memberId));
        const name = displayName(member?.name, 'this member');
        if (!window.confirm(`Remove ${name} from the group?`)) return;

        fetch(api.removeGroupMember, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                group_id: Number(activeGroupId),
                member_id: Number(memberId)
            })
        })
        .then(res => res.json().then(data => ({ ok: res.ok, data })))
        .then(({ ok, data }) => {
            if (ok && data.success) {
                location.reload();
            } else {
                alert(data.error || 'Could not remove member.');
            }
        })
        .catch(err => {
            console.error(err);
            alert('Could not remove member.');
        });
    }

    function acceptInvite(inviteId) {
        fetch(api.acceptInvite(inviteId), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'}
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                location.reload();
            }
        })
        .catch(err => console.error('Error:', err));
    }

    function declineInvite(inviteId) {
        fetch(api.declineInvite(inviteId), {
            method: 'POST',
            headers: {'Content-Type': 'application/json'}
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                location.reload();
            }
        })
        .catch(err => console.error('Error:', err));
    }

    function renderPendingInvites(invites, focusNew) {
        const stack = document.getElementById('inviteStackContainer');
        const panel = document.getElementById('pendingInvitePanel');
        if (!stack || !panel) return;

        const pending = Array.isArray(invites) ? invites : [];
        const newInviteIds = pending
            .map(invite => String(invite.id))
            .filter(inviteId => !knownInviteIds.has(inviteId));

        panel.classList.toggle('no-pending-invites', pending.length === 0);
        if (pending.length === 0) {
            stack.innerHTML = '<div id="emptyState" class="invite-empty-state"><span class="invite-empty-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><path d="M4 6h16v12H4z"></path><path d="m4 7 8 6 8-6"></path></svg></span><span>No pending invitations found.</span></div>';
            knownInviteIds = new Set();
            return;
        }

        stack.innerHTML = pending.map(invite => inviteCard(invite, newInviteIds.includes(String(invite.id)))).join('');
        knownInviteIds = new Set(pending.map(invite => String(invite.id)));

        if (focusNew && newInviteIds.length > 0) {
            if (document.getElementById('myQrModal')?.classList.contains('active')) {
                closeModal('myQrModal');
            }
            const card = document.getElementById(`invite-${newInviteIds[0]}`);
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.focus({ preventScroll: true });
                setTimeout(() => card.classList.remove('is-new'), 4500);
            }
        }
    }

    function inviteCard(invite, isNew) {
        const inviteId = escapeHtml(invite.id);
        return `
            <div class="invite-card ${isNew ? 'is-new' : ''}" id="invite-${inviteId}" data-invite-id="${inviteId}" tabindex="-1">
                <div class="invite-meta">
                    <div class="sender">${escapeHtml(displayName(invite.sender, 'NSman'))}</div>
                    <div class="group-target">wants you to join "${escapeHtml(invite.group_name || 'Group')}"</div>
                </div>
                <div class="invite-actions">
                    <button class="btn-accept" onclick="acceptInvite(${inviteId})">Accept</button>
                    <button class="btn-decline" onclick="declineInvite(${inviteId})">Decline</button>
                </div>
            </div>`;
    }

    function pollPendingInvites(focusNew = true) {
        fetch(api.pendingInvites)
            .then(res => {
                const contentType = res.headers.get('content-type') || '';
                if (!contentType.includes('application/json')) return null;
                return res.json();
            })
            .then(data => {
                if (data?.success) renderPendingInvites(data.invites, focusNew);
            })
            .catch(err => console.error('Invite poll failed:', err));
    }

    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(modal.id);
            }
        });
    });

    pollPendingInvites(false);
    window.setInterval(() => {
        if (!document.hidden) pollPendingInvites(true);
    }, 4000);

    window.openModal = openModal;
    window.closeModal = closeModal;
    window.selectTab = selectTab;
    window.setLeaderboardSort = setLeaderboardSort;
    window.submitCreateGroup = submitCreateGroup;
    window.openMyQr = openMyQr;
    window.openQrScanner = openQrScanner;
    window.leaveActiveGroup = leaveActiveGroup;
    window.removeGroupMember = removeGroupMember;
    window.acceptInvite = acceptInvite;
    window.declineInvite = declineInvite;
})();
