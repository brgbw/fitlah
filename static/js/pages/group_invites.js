(function () {
    const groupDataElement = document.getElementById('groupRosterData');
    const groupRosterData = groupDataElement ? JSON.parse(groupDataElement.textContent || '[]') : [];

    const api = {
        createGroup: '/api/create-group',
        addMember: '/api/add-member',
        acceptInvite: (inviteId) => `/api/accept-invite/${inviteId}`,
        declineInvite: (inviteId) => `/api/decline-invite/${inviteId}`
    };

    let activeGroupId = groupRosterData[0]?.group?.id || null;
    let leaderboardSort = document.getElementById('leaderboardSort')?.value || 'desc';

    function openModal(modalId) {
        document.getElementById(modalId).classList.add('active');
    }

    function closeModal(modalId) {
        document.getElementById(modalId).classList.remove('active');
    }

    function sortedMembers(members) {
        return [...members].sort((a, b) => {
            const aScore = Number(a.ippt_score?.total_points || a.ippt_points || 0);
            const bScore = Number(b.ippt_score?.total_points || b.ippt_points || 0);
            return leaderboardSort === 'asc' ? aScore - bScore : bScore - aScore;
        });
    }

    function renderRoster(groupId) {
        const tableBody = document.getElementById('groupTableBody');
        const mobileList = document.getElementById('mobileLeaderboardList');
        activeGroupId = Number(groupId);
        const selected = groupRosterData.find(item => item.group.id === Number(groupId));

        if (!selected || selected.members.length === 0) {
            tableBody.innerHTML = '<tr><td colspan="7" class="empty-state">No roster records available for this group yet.</td></tr>';
            if (mobileList) {
                mobileList.innerHTML = '<div class="mobile-empty-state">No roster records available for this group yet.</div>';
            }
            return;
        }

        const members = sortedMembers(selected.members);
        tableBody.innerHTML = members.map(member => {
            const best = member.personal_best || {};
            const score = member.ippt_score || {};
            const award = score.award || {};

            return `
                <tr>
                    <td>
                        <strong>${escapeHtml(member.name || 'NSman')}</strong>
                        <span class="user-id-tag">${escapeHtml(member.nric || '')}</span>
                    </td>
                    <td class="pb-cell">
                        <div class="pb-value">${member.age || '--'}</div>
                        <span class="pb-unit">${escapeHtml(member.age_group || 'Age Band')}</span>
                    </td>
                    <td class="pb-cell">
                        <div class="pb-value">${best.pushups || '--'}</div>
                        <span class="pb-unit">Reps</span>
                    </td>
                    <td class="pb-cell">
                        <div class="pb-value">${best.situps || '--'}</div>
                        <span class="pb-unit">Reps</span>
                    </td>
                    <td class="pb-cell">
                        <div class="pb-value">${escapeHtml(best.run_time || '--:--')}</div>
                        <span class="pb-unit">Minutes</span>
                    </td>
                    <td class="pb-cell">
                        <div class="pb-value">${score.total_points || 0}</div>
                        <span class="pb-unit">Points</span>
                    </td>
                    <td>
                        <span class="status-badge-pill ${escapeHtml(award.code || 'fail')}">
                            ${escapeHtml(award.label || 'Fail')}
                        </span>
                    </td>
                </tr>`;
        }).join('');

        if (mobileList) {
            mobileList.innerHTML = members.map(member => mobileLeaderCard(member)).join('');
        }
    }

    function mobileLeaderCard(member) {
        const best = member.personal_best || {};
        const score = member.ippt_score || {};
        const award = score.award || {};
        const points = score.total_points ?? member.ippt_points ?? 0;
        return `
            <article class="leader-card">
                <div class="leader-card-top">
                    <div class="leader-name">
                        <strong>${escapeHtml(member.name || 'NSman')}</strong>
                        <span class="user-id-tag">${escapeHtml(member.nric || '')}</span>
                    </div>
                    <div class="leader-score">
                        <strong>${escapeHtml(points)}</strong>
                        <span>points</span>
                    </div>
                </div>
                <div class="leader-meta-row">
                    <span>${escapeHtml(member.age || '--')} yrs · ${escapeHtml(member.age_group || 'Age Band')}</span>
                    <span class="status-badge-pill ${escapeHtml(award.code || 'fail')}">
                        ${escapeHtml(award.label || 'Fail')}
                    </span>
                </div>
                <div class="leader-metrics">
                    <div class="leader-metric"><span>Push</span><strong>${escapeHtml(best.pushups || '--')}</strong></div>
                    <div class="leader-metric"><span>Sit</span><strong>${escapeHtml(best.situps || '--')}</strong></div>
                    <div class="leader-metric"><span>Run</span><strong>${escapeHtml(best.run_time || '--:--')}</strong></div>
                </div>
            </article>`;
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

    function selectTab(tabElement) {
        if (tabElement.classList.contains('create-group-pill')) return;
        const pills = document.querySelectorAll('.filter-pill:not(.create-group-pill)');
        pills.forEach(p => p.classList.remove('active'));
        tabElement.classList.add('active');
        document.getElementById('tableTitleContext').innerText = `${tabElement.innerText} IPPT Score Points`;
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

    function addChipToken() {
        const input = document.getElementById('modalTokenInput');
        const val = input.value.trim().toUpperCase();
        if (!val) return;

        const tray = document.getElementById('modalTokenTray');
        const chip = document.createElement('div');
        const removeButton = document.createElement('span');

        chip.className = 'identity-chip';
        chip.dataset.nric = val;
        chip.append(document.createTextNode(`${val} `));

        removeButton.innerHTML = '&times;';
        removeButton.addEventListener('click', () => chip.remove());
        chip.appendChild(removeButton);

        tray.appendChild(chip);
        input.value = '';
    }

    function submitCreateGroup() {
        const groupName = document.getElementById('newGroupName').value.trim();
        const invitedNrics = Array.from(document.querySelectorAll('#modalTokenTray .identity-chip'))
            .map(chip => chip.dataset.nric)
            .filter(Boolean);
        if (!groupName) {
            alert('Please enter a group name.');
            return;
        }

        fetch(api.createGroup, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ group_name: groupName, invited_nrics: invitedNrics })
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

    function addMemberToGroup() {
        const input = document.getElementById('memberIdInput');
        const val = input.value.trim().toUpperCase();
        const activeTab = document.querySelector('.filter-pill.active:not(.create-group-pill)');
        if (!val) {
            alert('Please enter a member identifier.');
            return;
        }
        if (!activeTab) {
            alert('Create or select a group first.');
            return;
        }

        fetch(api.addMember, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                group_id: Number(activeTab.dataset.groupId),
                nric: val
            })
        })
        .then(res => res.json().then(data => ({ ok: res.ok, data })))
        .then(({ ok, data }) => {
            if (ok && data.success) {
                alert(`Invitation sent to ${val}.`);
                input.value = '';
            } else {
                alert(data.error || 'Could not send invite.');
            }
        })
        .catch(err => {
            console.error(err);
            alert('Could not send invite.');
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

    document.querySelectorAll('.modal-overlay').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                
                modal.classList.remove('active');
            }
        });
    });

    window.openModal = openModal;
    window.closeModal = closeModal;
    window.selectTab = selectTab;
    window.setLeaderboardSort = setLeaderboardSort;
    window.addChipToken = addChipToken;
    window.submitCreateGroup = submitCreateGroup;
    window.addMemberToGroup = addMemberToGroup;
    window.acceptInvite = acceptInvite;
    window.declineInvite = declineInvite;
})();
