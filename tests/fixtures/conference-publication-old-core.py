# 保留作者来源检查引入前的三个真实生产函数，仅用于旧实现反例回归。

def process_bundle(conference_id, process_id):
    safe_uuid(process_id, 'processId')
    if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,80}', conference_id or ''):
        raise ConferencePublicationError('conferenceId 不安全')
    process_dir = PROCESS_ROOT / process_id
    state = read_json(process_dir / 'state.json')
    if state.get('processId') != process_id or state.get('status') != 'complete' \
            or state.get('authority', {}).get('conferenceId') != conference_id:
        raise ConferencePublicationError('会议 process 尚未以 complete 状态闭合')
    items = state.get('items')
    if not isinstance(items, dict) or not items or any(item.get('status') != 'complete'
                                                       for item in items.values()):
        raise ConferencePublicationError('会议仍有未完成论文，拒绝发布')
    completion = read_json(process_dir / 'completion-receipt.json')
    completion_body = dict(completion)
    declared = completion_body.pop('receiptSha256', None)
    if not SHA_RE.fullmatch(str(declared or '')) or stable(completion_body) != declared \
            or completion.get('processId') != process_id \
            or completion.get('authority', {}).get('conferenceId') != conference_id \
            or state.get('completionReceiptSha256') != declared:
        raise ConferencePublicationError('completion receipt 与 process state 不闭合')

    aggregate_proof = state.get('aggregate')
    if not isinstance(aggregate_proof, dict):
        raise ConferencePublicationError('会议缺少 aggregate proof')
    aggregate_path = find_manifest(AGGREGATE_ROOT / conference_id,
                                   aggregate_proof.get('manifestSha256'), 'aggregate')
    aggregate_manifest = read_json(aggregate_path)
    aggregate_dir = aggregate_path.parent
    aggregate_md = aggregate_dir / 'aggregate.md'
    aggregate_bytes = read_bytes(aggregate_md)
    if aggregate_manifest.get('status') != 'complete' \
            or aggregate_manifest.get('conferenceId') != conference_id \
            or aggregate_manifest.get('aggregateId') != aggregate_proof.get('aggregateId') \
            or aggregate_manifest.get('pagePath') != aggregate_proof.get('pagePath') \
            or aggregate_manifest.get('markdownSha256') != sha_bytes(aggregate_bytes) \
            or aggregate_manifest.get('markdown') != aggregate_bytes.decode('utf-8') \
            or aggregate_manifest.get('markdownSha256') != aggregate_proof.get('markdownSha256') \
            or manifest_sha(aggregate_manifest) != aggregate_proof.get('manifestSha256'):
        raise ConferencePublicationError(
            'aggregate staging 与 completion proof 不一致：'
            'status/conferenceId/aggregateId/pagePath/markdownSha256/markdown/manifestSha256 至少一项不符')
    _validate_aggregate_tag_format(aggregate_manifest)
    aggregate_target = safe_relative(aggregate_manifest['pagePath'], 'aggregate pagePath')

    files = []
    image_files = []
    seen_targets = set()
    seen_image_targets = set()
    for paper_id, item in sorted(items.items()):
        proof = item.get('pageProof')
        if not isinstance(proof, dict):
            raise ConferencePublicationError(f'论文缺少 page proof: {paper_id}')
        manifest_path = find_manifest(PAGE_ROOT, proof.get('manifestSha256'), paper_id)
        manifest = read_json(manifest_path)
        page_path = safe_relative(manifest.get('pagePath'), f'{paper_id} pagePath')
        page_bytes = read_bytes(manifest_path.parent / 'page.md')
        if manifest.get('status') != 'complete' or manifest.get('paperId') != paper_id \
                or manifest.get('analysisExecutionId') != item.get('analysisRunId') \
                or manifest.get('contentSha256') != sha_bytes(page_bytes) \
                or manifest.get('contentSha256') != proof.get('contentSha256') \
                or manifest.get('manifestSha256') != proof.get('manifestSha256') \
                or manifest_sha(manifest) != proof.get('manifestSha256'):
            raise ConferencePublicationError(f'论文暂存记录与进程凭证不一致：{paper_id}')
        _validate_paper_tag_format(manifest)
        text = page_bytes.decode('utf-8')
        required = [f'paper_digest_paper_id: "{paper_id}"',
                    'paper_digest_source_kind: conference',
                    f'paper_digest_conference_id: "{conference_id}"']
        if not text.startswith('---\n') or any(marker not in text for marker in required) \
                or 'paper_digest_arxiv_id' in text or 'arxiv.org' in text.lower():
            raise ConferencePublicationError(f'论文页面身份或 arXiv 隔离门禁失败: {paper_id}')
        if page_path in seen_targets or page_path == aggregate_target:
            raise ConferencePublicationError(f'会议目标路径重复: {page_path}')
        seen_targets.add(page_path)
        files.append({'kind': 'paper', 'paperId': paper_id, 'path': page_path,
                      'sourcePath': str(manifest_path.parent / 'page.md'),
                      'manifestSha256': proof['manifestSha256'],
                      'sourceSha256': sha_bytes(page_bytes), 'size': len(page_bytes)})
        assets = manifest.get('assets') or []
        if not isinstance(assets, list):
            raise ConferencePublicationError(f'论文资产清单非法: {paper_id}')
        declared_asset_paths = set()
        for asset in assets:
            if not isinstance(asset, dict) or set(asset) != {'path', 'sha256', 'size'}:
                raise ConferencePublicationError(f'论文资产记录非法: {paper_id}')
            asset_path = safe_relative(asset.get('path'), f'{paper_id} asset path')
            asset_bytes = read_bytes(manifest_path.parent / 'assets' / asset_path)
            if asset.get('sha256') != sha_bytes(asset_bytes) or asset.get('size') != len(asset_bytes):
                raise ConferencePublicationError(f'论文资产与 staging 不一致: {paper_id} {asset_path}')
            image_target = safe_image_relative('/'.join(Path(asset_path).parts[3:]),
                                               f'{paper_id} image asset path')
            if image_target in seen_image_targets:
                raise ConferencePublicationError(f'图片仓库目标路径重复: {image_target}')
            seen_image_targets.add(image_target)
            declared_asset_paths.add(asset_path)
            image_files.append({'kind': 'asset', 'paperId': paper_id, 'path': image_target,
                                'sourcePath': str(manifest_path.parent / 'assets' / asset_path),
                                'manifestSha256': proof['manifestSha256'],
                                'sourceSha256': sha_bytes(asset_bytes), 'size': len(asset_bytes)})

        # 页面自身没问题，它引用的 PNG 却可能不在本次发布增量里。第一次 EACL
        # 发布就出过这事：Markdown 页面提交了，static/images/ 却没跟踪，
        # 结果每张插图都是打不开的线上 URL。所以在生成和推送之前，
        # 这里先把页面到资产的这条边收口。
        referenced_asset_paths = set()
        for url in CONFERENCE_IMAGE_RE.findall(text):
            asset_path = conference_asset_path_from_url(url)
            if asset_path is not None:
                referenced_asset_paths.add(asset_path)
            elif 'audio-paper-digest-images' in url or '/images/conference/' in url:
                raise ConferencePublicationError(
                    f'论文 Markdown 引用了非法会议图片 URL: {paper_id}: {url}'
                )
        missing_assets = sorted(referenced_asset_paths - declared_asset_paths)
        if missing_assets:
            raise ConferencePublicationError(
                f'论文 Markdown 引用了未进入 staging 的会议图片: {paper_id}: {missing_assets}'
            )

    aggregate_text = aggregate_bytes.decode('utf-8')
    if not aggregate_text.startswith('---\n') \
            or 'paper_digest_page_type: index' not in aggregate_text \
            or f'conference-{conference_id}' not in aggregate_text \
            or 'paper_digest_arxiv_id' in aggregate_text or 'arxiv.org' in aggregate_text.lower():
        raise ConferencePublicationError('会议汇总页面身份或 arXiv 隔离门禁失败')
    files.append({'kind': 'aggregate', 'paperId': None, 'path': aggregate_target,
                  'sourcePath': str(aggregate_md),
                  'manifestSha256': aggregate_proof['manifestSha256'],
                  'sourceSha256': sha_bytes(aggregate_bytes), 'size': len(aggregate_bytes)})
    return {'state': state, 'completion': completion, 'files': files,
            'imageFiles': image_files, 'aggregate': aggregate_manifest}


def generate(conference_id, process_id):
    repo, images = blog_repo(), image_repo()
    with shared_blog_repository_lock(repo, owner=f'conference-generate:{conference_id}'), \
            shared_blog_repository_lock(images, owner=f'conference-generate-images:{conference_id}'):
        if (publication_dir(conference_id, process_id) / 'publish.json').exists():
            # 格式升级不能成为重新生成已发布内容的理由。
            result = publication_state(conference_id, process_id)
            print(json.dumps(result, ensure_ascii=False))
            return result
        bundle = process_bundle(conference_id, process_id)
        snapshot = remote_snapshot(repo)
        files = sorted(bundle['files'], key=lambda item: item['path'])
        image_files = sorted(bundle['imageFiles'], key=lambda item: item['path'])
        existing = publication_dir(conference_id, process_id) / 'generation.json'
        image_snapshot = remote_snapshot(images)
        rebased = False
        if existing.exists() and read_json(existing).get('version') == 2:
            previous_record = read_json(existing)
            check_self_hash(previous_record, 'generationSha256')
            implementation_changed = previous_record.get('implementationSha256') != gate_fingerprint()
            needs_rebase = (
                not can_resume_existing_generation(
                    repo, previous_record.get('baseHead'),
                    previous_record.get('remoteIdentitySha256'), previous_record.get('files') or [])
                or not can_resume_existing_generation(
                    images, previous_record.get('imageBaseHead'),
                    previous_record.get('imageRemoteIdentitySha256'), previous_record.get('imageFiles') or []))
            if needs_rebase:
                validate_unpublished_rebase(repo, images, previous_record, snapshot, image_snapshot,
                                            new_source_sha={item['path']: item['sourceSha256']
                                                            for item in files},
                                            new_image_source_sha={item['path']: item['sourceSha256']
                                                                  for item in image_files})
                previous = previous_record
                rebased = True
            else:
                previous, _, _ = validate_generation(
                    conference_id, process_id, repo, images,
                    allow_owned_target_drift=implementation_changed,
                    new_image_source_sha={item['path']: item['sourceSha256']
                                          for item in image_files},
                    new_source_sha={item['path']: item['sourceSha256']
                                    for item in files}
                )
            same_implementation = previous.get('implementationSha256') == gate_fingerprint()
            completion_changed = previous['completionReceiptSha256'] != bundle['completion']['receiptSha256']
            if same_implementation and not completion_changed and (previous['files'] != files
                    or previous['imageFiles'] != image_files):
                raise ConferencePublicationError('同一 process 的发布内容已变化')
            # 暂存字节是当前渲染器与发布约定的产物。渲染器或检查器一变，就必须
            # 把同一批已完成论文重新产出，review 才不会去审过期的 Markdown。
            # 更早的 v2 凭证没有这个指纹，因此会有意走一次重新生成。
            if same_implementation and not completion_changed and not rebased:
                print(json.dumps({'status': 'already-generated', 'conferenceId': conference_id}))
                return
        if snapshot['head'] != snapshot['remoteMain'] or image_snapshot['head'] != image_snapshot['remoteMain']:
            raise ConferencePublicationError('generate 拒绝已有未同步本地/远端提交')
        verify_index(repo, snapshot['head'], files)
        verify_index(images, image_snapshot['head'], image_files)
        dirty = set(git(repo, 'diff', '--name-only', '-z').stdout.rstrip('\0').split('\0')) - {''}
        if dirty & {record['path'] for record in files}:
            # 中断的生成可能已经把精确字节写到位了。
            for record in files:
                if record['path'] in dirty and sha_bytes(target_bytes(repo, record)) != record['sourceSha256']:
                    raise ConferencePublicationError(f'会议目标存在人工修改: {record["path"]}')
        for record in files:
            target = under(repo, record['path'], '博客目标')
            data = read_bytes(record['sourcePath'])
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError(f'staging 字节在生成期间漂移: {record["path"]}')
            if target.exists() and read_bytes(target) != data:
                if not can_replace_conference_target(target, data, conference_id, record['kind']):
                    raise ConferencePublicationError(f'博客已有非本会议流水线内容，拒绝覆盖: {record["path"]}')
                replace_exact(target, data)
            if not target.exists():
                write_exact(target, data, mode=0o644)
        for record in image_files:
            target = under(images, record['path'], '图片仓库目标')
            data = read_bytes(record['sourcePath'])
            if sha_bytes(data) != record['sourceSha256']:
                raise ConferencePublicationError(f'图片 staging 字节在生成期间漂移: {record["path"]}')
            write_exact(target, data, mode=0o644)
        body = {'contract': 'conference-blog-generation-v1', 'version': 2,
                'conferenceId': conference_id, 'processId': process_id,
                'completionReceiptSha256': bundle['completion']['receiptSha256'],
                'implementationSha256': gate_fingerprint(),
                'baseHead': snapshot['head'], 'remoteMainBefore': snapshot['remoteMain'],
                'remoteName': snapshot['remoteName'],
                'remoteIdentitySha256': snapshot['remoteIdentitySha256'],
                'files': files, 'imageFiles': image_files,
                'imageBaseHead': image_snapshot['head'],
                'imageRemoteMainBefore': image_snapshot['remoteMain'],
                'imageRemoteIdentitySha256': image_snapshot['remoteIdentitySha256']}
        generation = {**body, 'generationSha256': stable(body)}
        rewrite_unpublished_receipt(
            publication_dir(conference_id, process_id) / 'generation.json',
            json_bytes(generation), 'generation receipt',
            lambda previous: (
                previous.get('contract') == body['contract']
                and previous.get('version') in {1, 2}
                and previous.get('conferenceId') == conference_id
                and previous.get('processId') == process_id
                # process_bundle() 已经认证过当前这个完整流程和每一份暂存字节。
                # 因此只要同一个流程是确定性地迁移过来的（哪怕只是展示内容
                # 变了），未发布的凭证就可以被替换。
            )
        )
        print(json.dumps({'status': 'generated', 'conferenceId': conference_id,
                          'processId': process_id, 'files': len(files),
                          'generationSha256': generation['generationSha256']}, ensure_ascii=False))


def validate_generation(conference_id, process_id, repo, images, *,
                        allow_owned_target_drift=False, allow_committed=False,
                        new_image_source_sha=None, new_source_sha=None):
    generation = load_generation(conference_id, process_id)
    body = dict(generation)
    declared = body.pop('generationSha256', None)
    if generation.get('contract') != 'conference-blog-generation-v1' or generation.get('version') not in {1, 2} \
            or declared != stable(body) or generation.get('conferenceId') != conference_id \
            or generation.get('processId') != process_id:
        raise ConferencePublicationError(
            f'generation receipt 无效：contract={generation.get("contract")!r}，'
            f'version={generation.get("version")!r}，自哈希 {"通过" if declared == stable(body) else "不符"}，'
            f'conferenceId={generation.get("conferenceId")!r}，processId={generation.get("processId")!r}')
    if generation['baseHead'] != generation['remoteMainBefore'] \
            or generation['imageBaseHead'] != generation['imageRemoteMainBefore']:
        raise ConferencePublicationError('generation 基线未与远端闭合')
    if allow_committed:
        snapshot = remote_snapshot(repo)
        if snapshot['remoteIdentitySha256'] != generation['remoteIdentitySha256'] \
                or generation['remoteMainBefore'] != generation['baseHead']:
            raise ConferencePublicationError('博客 HEAD 或远端 main 在会议发布期间发生漂移')
        if snapshot['head'] != generation['baseHead']:
            verify_own_commit(repo, snapshot['head'], generation['baseHead'], generation['files'])
            if snapshot['remoteMain'] not in (generation['remoteMainBefore'], snapshot['head']):
                raise ConferencePublicationError('恢复发布时远端 main 漂移')
        elif snapshot['remoteMain'] != generation['remoteMainBefore']:
            raise ConferencePublicationError('博客 HEAD 或远端 main 在会议发布期间发生漂移')
    else:
        snapshot = transaction_snapshot(repo, generation['baseHead'],
                                        generation['remoteIdentitySha256'], generation['files'],
                                        new_source_sha=new_source_sha)
    for record in generation.get('files', []):
        data = target_bytes(repo, record)
        if sha_bytes(data) != record['sourceSha256']:
            # 有主字节等值放行：目标恰等于本次生成的 staged 源字节（权威源已落位，
            # 中断恢复/经审修复场景）→ 放行，新 generation 将以源字节刷新记录。
            staged_sha = (new_source_sha or {}).get(record['path'])
            if staged_sha is not None and sha_bytes(data) == staged_sha:
                continue
            if not allow_owned_target_drift or not can_replace_conference_target(
                    under(repo, record['path'], '博客目标'), data,
                    conference_id, record['kind']):
                raise ConferencePublicationError(f'博客目标字节与 generation 不一致: {record["path"]}')
    image_files = generation.get('imageFiles')
    if not isinstance(image_files, list):
        raise ConferencePublicationError('generation 缺少图片仓库文件清单')
    image_snapshot = transaction_snapshot(images, generation['imageBaseHead'],
                                          generation['imageRemoteIdentitySha256'], image_files,
                                          new_source_sha=new_image_source_sha)
    for record in image_files:
        data = target_bytes(images, record)
        if sha_bytes(data) != record['sourceSha256']:
            # 有主图片漂移：目标字节恰等于本次生成的 staged 源字节（本次权威源已落在目标，
            # 多见于中断恢复与经审重裁的资产）→ 放行，新 generation 将以 staged 源刷新记录；
            # 其余漂移照旧 fail-closed（asset 无内容标记，不用 kind 探测，只认字节等值）。
            staged_sha = (new_image_source_sha or {}).get(record['path'])
            if not staged_sha or sha_bytes(data) != staged_sha:
                raise ConferencePublicationError(f'图片仓库目标字节与 generation 不一致: {record["path"]}')
    return generation, snapshot, image_snapshot

