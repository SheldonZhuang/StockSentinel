<template>
  <div class="signal-badge-group">
    <div
      v-for="s in signals"
      :key="s.key"
      :class="['badge', s.key, { active: current === s.key, inactive: current !== s.key }]"
    >
      {{ s.emoji }} {{ $t(`signal.${s.key}`) }}
    </div>
  </div>
</template>

<script setup>
defineProps({
  current: {
    type: String,
    default: 'neutral', // 'attack' | 'neutral' | 'defense'
  },
});

const signals = [
  { key: 'attack', emoji: '🟢' },
  { key: 'neutral', emoji: '🟡' },
  { key: 'defense', emoji: '🔴' },
];
</script>

<style scoped>
.signal-badge-group {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}

.badge {
  padding: 10px 22px;
  border-radius: 12px;
  font-weight: 700;
  font-size: 16px;
  transition: opacity 0.2s, transform 0.2s;
  white-space: nowrap;
}

.badge.attack { background: #173a24; color: #4ade80; border: 1px solid #2d5a3d; }
.badge.neutral { background: #3a3416; color: #facc15; border: 1px solid #5a5020; }
.badge.defense { background: #3a1717; color: #f87171; border: 1px solid #5a2020; }

.badge.active {
  opacity: 1;
  transform: scale(1.05);
  box-shadow: 0 0 16px rgba(255,255,255,0.1);
}

.badge.inactive {
  opacity: 0.35;
  transform: scale(1);
}
</style>
