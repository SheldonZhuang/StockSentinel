<template>
  <div class="admin-view">
    <!-- S5 执行台：仅管理员的个人策略驾驶舱（96号，暂不对外展示） -->
    <S5Panel />
    <AdminPanel />
  </div>
</template>

<script setup>
import S5Panel from '../components/S5Panel.vue';
import AdminPanel from '../components/AdminPanel.vue';
</script>

<style scoped>
.admin-view { padding: 0; }
</style>
