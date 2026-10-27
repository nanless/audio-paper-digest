#include <jni.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

static int same_file(const struct stat *a, const struct stat *b) {
    return S_ISREG(b->st_mode) && b->st_dev == a->st_dev && b->st_ino == a->st_ino &&
           b->st_uid == a->st_uid && b->st_mode == a->st_mode && b->st_nlink == 1;
}
static int owned_at(int directory, const char *name, const struct stat *created) {
    struct stat current;
    return fstatat(directory, name, &current, AT_SYMLINK_NOFOLLOW) == 0 && same_file(created, &current);
}
static int durable(int fd) {
    int r; do { r = fsync(fd); } while (r < 0 && errno == EINTR);
    return r == 0 ? 0 : errno;
}

JNIEXPORT jint JNICALL
Java_com_nanless_paperdigest_model_CapturePublicationNative_publishNoReplace(
        JNIEnv *env, jclass type, jstring target, jbyteArray content, jstring nonce) {
    (void) type;
    if (target == NULL || content == NULL || nonce == NULL) return EINVAL;
    int result = EINVAL, directory = -1, fd = -1, created_known = 0;
    struct stat created, folder;
    char temporary[96] = {0};
    char *parent = NULL;
    const char *to = (*env)->GetStringUTFChars(env, target, NULL);
    if (to == NULL) return ENOMEM;
    const char *id = (*env)->GetStringUTFChars(env, nonce, NULL);
    if (id == NULL) { (*env)->ReleaseStringUTFChars(env, target, to); return ENOMEM; }
    jsize length = (*env)->GetArrayLength(env, content);
    if (length <= 0 || length > 16 * 1024 * 1024 || strlen(id) != 36) goto cleanup;
    for (int i = 0; i < 36; i++) if (!((id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f') || id[i] == '-')) goto cleanup;
    parent = strdup(to);
    if (parent == NULL) { result = ENOMEM; goto cleanup; }
    char *name = strrchr(parent, '/');
    if (name == NULL || name == parent || name[1] == 0 || strcmp(name + 1, ".") == 0 || strcmp(name + 1, "..") == 0) goto cleanup;
    *name++ = 0;
    if (parent[0] != '/') goto cleanup;
    // O_PATH 只需祖先的搜索权限；例如 Android /data 不向 App 提供目录读取权限。
    directory = open("/", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (directory < 0) { result = errno; goto cleanup; }
    char *walk = NULL;
    for (char *part = strtok_r(parent, "/", &walk); part != NULL; part = strtok_r(NULL, "/", &walk)) {
        if (strcmp(part, ".") == 0 || strcmp(part, "..") == 0) { result = EINVAL; goto cleanup; }
        int next = openat(directory, part, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) { result = errno; goto cleanup; }
        close(directory); directory = next;
    }
    int writable_parent = openat(directory, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (writable_parent < 0) { result = errno; goto cleanup; }
    close(directory); directory = writable_parent;
    if (fstat(directory, &folder) < 0) { result = errno; goto cleanup; }
    if (!S_ISDIR(folder.st_mode) || folder.st_uid != getuid()) { result = EACCES; goto cleanup; }
    snprintf(temporary, sizeof(temporary), ".capture-promotion-%s.tmp", id);
    fd = openat(directory, temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) { result = errno; goto cleanup; }
    // 创建身份来自实际仍打开的 fd；不能从稍后的路径属性自授所有权。
    if (fstat(fd, &created) < 0) { result = errno; goto cleanup; }
    created_known = 1;
    if (!S_ISREG(created.st_mode) || created.st_uid != getuid() || created.st_nlink != 1 || (created.st_mode & 0777) != 0600) { result = EACCES; goto cleanup; }
    for (jsize offset = 0; offset < length;) {
        jbyte buffer[65536];
        jsize count = length - offset < (jsize) sizeof(buffer) ? length - offset : (jsize) sizeof(buffer);
        (*env)->GetByteArrayRegion(env, content, offset, count, buffer);
        if ((*env)->ExceptionCheck(env)) { result = EIO; goto cleanup; }
        for (ssize_t sent = 0; sent < count;) {
            ssize_t wrote = write(fd, buffer + sent, (size_t) (count - sent));
            if (wrote < 0 && errno == EINTR) continue;
            if (wrote <= 0) { result = wrote == 0 ? EIO : errno; goto cleanup; }
            sent += wrote;
        }
        offset += count;
    }
    result = durable(fd);
    if (result != 0) goto cleanup;
    struct stat finished;
    if (fstat(fd, &finished) < 0) { result = errno; goto cleanup; }
    if (!same_file(&created, &finished) || finished.st_size != length || !owned_at(directory, temporary, &created)) { result = ESTALE; goto cleanup; }
#ifdef SYS_renameat2
    // 只移动完整暂存；RENAME_NOREPLACE=1 在内核原子地拒绝任何已存在目标。
    if (syscall(SYS_renameat2, directory, temporary, directory, name, 1) < 0) { result = errno; goto cleanup; }
    if (!owned_at(directory, name, &created)) { result = ESTALE; goto cleanup; }
    result = durable(directory);
#else
    result = ENOSYS;
#endif
cleanup:
    // fd 保持打开直至检查/清理结束，避免已释放 inode 被 foreign 文件重用。
    if (created_known && directory >= 0 && owned_at(directory, temporary, &created)) {
        if (unlinkat(directory, temporary, 0) < 0) result = errno == EEXIST ? EIO : errno;
    }
    if (fd >= 0) close(fd);
    if (directory >= 0) close(directory);
    free(parent);
    (*env)->ReleaseStringUTFChars(env, nonce, id);
    (*env)->ReleaseStringUTFChars(env, target, to);
    return result;
}
