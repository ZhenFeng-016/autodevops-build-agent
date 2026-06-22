export * from './protocol.js';
export type DeployDriver = 'docker' | 'pm2';
export type DeployPackaging = 'docker_image' | 'pm2_source';
export type ProjectDeployMode = 'auto' | DeployPackaging;
export type ProjectAutomationMode = 'fetch_only' | 'fetch_install' | 'deploy';
export type ProjectActionStatus = 'idle' | JobStatus;
export type DatabaseInitMode = 'skip' | 'init_on_first_deploy';
export type PipelineRunStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected';
export type IncidentStatus = 'open' | 'analyzing' | 'fix_pending_review' | 'recovered' | 'resolved';
export type CodexFixStatus = 'draft' | 'pending_review' | 'approved' | 'pipeline_running' | 'merge_pending_approval' | 'merge_queued' | 'merged' | 'deployed' | 'rejected';
export type ServerRole = 'platform' | 'build' | 'runtime' | 'observability';
export type AgentStatus = 'online' | 'offline' | 'degraded' | 'disabled';
export type JobStatus = 'queued' | 'claimed' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobType = 'repo.inspect' | 'repo.sync' | 'repo.install' | 'jenkins.pipeline.run' | 'codex.incident.analyze' | 'codex.fix.create_patch' | 'codex.fix.merge_to_production' | 'observability.preflight';
export interface Project {
    id: string;
    name: string;
    repositoryUrl: string;
    defaultBranch: string;
    developmentBranch?: string;
    productionBranch?: string;
    environment: string;
    productionServerPath?: string;
    healthPath?: string;
    buildServerId?: string;
    runtimeServerId?: string;
    codeSyncTargetIds?: string[];
    repositoryVisibility?: 'public' | 'private';
    repositoryAuthType?: 'none' | 'ssh_key' | 'token';
    repositoryAuthRef?: string;
    automationMode?: ProjectAutomationMode;
    deployMode?: ProjectDeployMode;
    databaseInitMode?: DatabaseInitMode;
    lastActionId?: string;
    lastActionType?: JobType;
    lastActionStatus?: ProjectActionStatus;
    lastActionJobId?: string;
    lastActionTotalJobs?: number;
    lastActionDoneJobs?: number;
    lastActionError?: string;
    lastActionStartedAt?: string;
    lastActionFinishedAt?: string;
    lastActionUpdatedAt?: string;
    ports?: ProjectPortSummary;
}
export type ProjectPortPurpose = 'backend_runtime' | 'frontend_nginx' | 'docker_host';
export interface ProjectPortBinding {
    purpose: ProjectPortPurpose;
    port: number;
    reservationId: string;
    status: string;
}
export interface ProjectPortSummary {
    authority: 'platform';
    ready: boolean;
    backendRuntime?: ProjectPortBinding;
    frontendNginx?: ProjectPortBinding;
    dockerHost?: ProjectPortBinding;
}
export interface ProjectEnvReview {
    projectId: string;
    environment: string;
    envFileName: string;
    envFileCandidates: string[];
    ready: boolean;
    missingRequiredKeys: string[];
    counts: {
        total: number;
        missing: number;
        systemManaged: number;
        extraUserProvided: number;
        confirmed: number;
    };
    items: Array<{
        key: string;
        required: boolean;
        type: string;
        managedBySystem: boolean;
        envFile?: string;
        status: 'confirmed' | 'missing_value' | 'extra_user_provided' | 'system_managed' | 'optional' | 'conflict';
        description?: string;
        defaultValue?: string;
        hasValue: boolean;
        valuePreview?: string;
        isSecret: boolean;
        valueSource?: string;
        confirmedAt?: string;
    }>;
}
export interface DeploymentPlan {
    projectId: string;
    environment: string;
    ready: boolean;
    deployReady: boolean;
    blockers: Array<{
        code: string;
        message: string;
        action?: string;
    }>;
    confirmationsRequired: string[];
    contract: {
        id?: string;
        status: 'missing' | 'draft' | 'approved';
    };
    pipeline: {
        id?: string;
        status: 'missing' | 'pending' | 'approved';
    };
    planApprovalStatus: 'required' | 'approved';
    server: {
        buildServerId?: string;
        runtimeServerId?: string;
        codeSyncTargetIds?: string[];
        runtimeHost?: string;
    };
    runtime: {
        driver: string;
        packaging: string;
        port?: number;
        serverPath?: string;
        healthPath?: string;
        healthUrl?: string;
        pm2AppName?: string;
        frontendPort?: number;
        dockerHostPort?: number;
        dockerContainerPort?: number;
    };
    port: {
        required: boolean;
        configured: boolean;
        reserved: boolean;
        reservationId?: string;
        conflict?: string;
        suggestedPort?: number;
        authority?: 'platform';
        bindings?: ProjectPortBinding[];
    };
    database: {
        required: boolean;
        configured: boolean;
        initMode: DatabaseInitMode;
        initializationRequired: boolean;
        initializationApprovalStatus: 'not_required' | 'required' | 'approved' | 'reserved' | 'consumed' | 'completed';
    };
    env: ProjectEnvReview;
}
export interface Server {
    id: string;
    name: string;
    role: ServerRole;
    status: 'active' | 'disabled';
    host?: string;
    sshTarget?: string;
    sshHost?: string;
    sshPort?: number;
    sshUser?: string;
    sshAuthType?: 'password' | 'private_key' | 'system_default' | string;
    publicKeyInstalledAt?: string;
    publicKeyFingerprint?: string;
    basePath?: string;
    labels?: Record<string, string>;
    metadata?: Record<string, unknown>;
}
export interface PortReservation {
    id: string;
    serverId: string;
    projectId?: string;
    environment: string;
    port: number;
    protocol: string;
    status: 'reserved' | 'active' | 'released' | string;
    reason?: string;
    metadata?: Record<string, unknown>;
    reservedAt?: string;
    releasedAt?: string;
}
export interface ServerCheck {
    id?: string;
    checkId: string;
    serverId: string;
    status: 'ready' | 'degraded' | 'failed' | 'not_run' | string;
    osFamily?: string;
    osVersion?: string;
    rawOutput?: Record<string, unknown>;
    createdAt?: string;
    items: Array<{
        id?: string;
        name: string;
        status: 'pass' | 'warn' | 'fail' | string;
        version?: string;
        required?: string;
        message?: string;
    }>;
}
export interface ServerProvisioningJob {
    id: string;
    jobId: string;
    serverId: string;
    status: 'running' | 'succeeded' | 'failed' | 'cancelled';
    kind: 'bootstrap' | 'build_agent_install' | 'codex_install' | string;
    component?: string;
    startedAt?: string;
    finishedAt?: string;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    metadata?: Record<string, unknown>;
}
export interface AgentCredentialStatus {
    agentId: string;
    mode: 'per-agent-hmac';
    status: string;
    version: number;
    rotatedAt?: string;
    lastUsedAt?: string;
    hasPreviousSecret: boolean;
}
export interface AgentAuthEvent {
    id: string;
    agentId?: string;
    result: 'succeeded' | 'failed' | string;
    reason?: string;
    method?: string;
    path?: string;
    createdAt?: string;
}
export interface AgentPool {
    id: string;
    name: string;
    description?: string;
    capabilities: string[];
    labels?: Record<string, string>;
}
export interface BuildAgent {
    id: string;
    name: string;
    status: AgentStatus;
    serverId?: string;
    server?: {
        id: string;
        name: string;
        role: string;
        host?: string;
    };
    poolId?: string;
    endpoint?: string;
    capabilities: string[];
    labels?: Record<string, string>;
    readiness?: AgentReadiness;
    runtimeStatus?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    currentJobId?: string;
    version?: string;
    agentVersion?: string;
    buildRevision?: string;
    protocolVersion?: number;
    supportedProtocolVersions?: number[];
    lastHeartbeatAt?: string;
}
export interface AgentReadiness {
    ready: boolean;
    status: 'ready' | 'degraded' | 'blocked';
    checks: Array<{
        name: string;
        status: 'pass' | 'warn' | 'fail';
        message?: string;
    }>;
}
export interface Job {
    id: string;
    type: JobType;
    status: JobStatus;
    targetProjectId?: string;
    sourceType?: string;
    sourceId?: string;
    projectActionId?: string;
    requiredCapabilities: string[];
    params: Record<string, unknown>;
    resultSummary?: Record<string, unknown>;
    errorSummary?: string;
    requestedBy?: string;
    assignedAgentId?: string;
    pipelineRunId?: string;
    incidentId?: string;
    codexFixId?: string;
    priority: number;
    createdAt?: string;
    acceptedAt?: string;
    startedAt?: string;
    finishedAt?: string;
    cancelledAt?: string;
    cancelledBy?: string;
    cancelReason?: string;
}
export interface JobAttempt {
    id: string;
    jobId: string;
    agentId: string;
    attemptNumber: number;
    status: JobStatus;
    agentWorkspacePath?: string;
    resultSummary?: Record<string, unknown>;
    errorSummary?: string;
    startedAt?: string;
    finishedAt?: string;
}
export interface JobEvent {
    id: string;
    jobId: string;
    attemptId?: string;
    agentId?: string;
    type: string;
    status?: string;
    message?: string;
    metadata?: Record<string, unknown>;
    createdAt?: string;
}
export interface ClaimedJob {
    job: Job;
    attempt: JobAttempt;
    leaseToken: string;
    leaseExpiresAt: string;
}
export interface OakDetection {
    detected: boolean;
    dependencies: string[];
    sourceMarkers: string[];
    scripts: Record<string, string>;
    evidence: string[];
    databaseConfigFiles: string[];
    initializationScript?: string;
}
export interface RepoInspection {
    projectId: string;
    repositoryPath: string;
    packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun';
    scripts: Record<string, string>;
    dockerfiles: string[];
    pm2Configs: string[];
    oak: OakDetection;
    framework: 'oak' | 'node' | 'unknown';
    recommendedDeploy: {
        driver: DeployDriver;
        packaging: DeployPackaging;
        reason: string;
    };
}
export interface RuntimeContract {
    id: string;
    projectId: string;
    environment: string;
    status: 'draft' | 'approved';
    automationMode: ProjectAutomationMode;
    commandInference?: {
        mode: ProjectAutomationMode;
        status: 'success' | 'warning' | 'failed' | 'skipped';
        summary: string;
        commands?: {
            checkout?: string[];
            install?: string[];
            codegen?: string[];
            validate?: string[];
            build?: string[];
            deploy?: string[];
        };
        validation?: Array<{
            command: string;
            purpose?: string;
            status?: string;
        }>;
        risks?: Array<{
            severity: 'low' | 'medium' | 'high';
            detail: string;
        }>;
        blockers?: string[];
    };
    runtime: {
        language: 'node' | 'unknown';
        framework: 'oak' | 'node' | 'unknown';
    };
    build: {
        packageManager: RepoInspection['packageManager'];
        installCommand: string;
        codegenCommands: string[];
        validationCommands: string[];
        frontendBuildCommand?: string;
        frontendDistDir?: string;
    };
    deploy: {
        driver: DeployDriver;
        packaging: DeployPackaging;
        modeSource: 'auto_detected' | 'user_selected';
        environment: string;
        strategy: 'docker_replace' | 'pm2_reload';
        serverPath?: string;
    };
    docker?: {
        dockerfile: string;
        context: string;
        imageRepository: string;
        imageTagTemplate: string;
        containerPort?: number;
        hostPort?: number;
    };
    pm2?: {
        appName: string;
        ecosystemFile: string;
        startCommand: string;
        port?: number;
        envFile?: string;
    };
    network?: {
        authority: 'platform';
        detectedPort?: number;
        backendRuntime?: ProjectPortBinding;
        frontendNginx?: ProjectPortBinding;
        dockerHost?: ProjectPortBinding;
    };
    health: {
        enabled: boolean;
        path?: string;
        url?: string;
    };
    database: {
        initMode: DatabaseInitMode;
        initializeData: boolean;
        migrationCommand?: string;
        dataInitCommand?: string;
        notes: string[];
        connectionSource?: 'oak_configuration' | 'environment' | 'unknown';
        configurationFiles?: string[];
    };
    environmentConfig: {
        envFileName: string;
        envFileCandidates: string[];
        variables: Array<{
            key: string;
            required: boolean;
            type: 'string' | 'number' | 'boolean' | 'secret' | string;
            managedBySystem?: boolean;
            defaultValue?: string;
            description?: string;
            envFile?: string;
        }>;
        notes: string[];
    };
    logs: {
        driver: 'docker' | 'pm2';
        lokiSelector: string;
    };
    requiresApproval: string[];
}
export interface PipelineDefinition {
    id: string;
    projectId: string;
    runtimeContractId: string;
    status: ApprovalStatus;
    deployDriver: DeployDriver;
    deployPackaging: DeployPackaging;
    jenkinsJobName: string;
    jenkinsfile: string;
}
export interface PipelineStage {
    id: string;
    pipelineRunId: string;
    name: string;
    status: PipelineRunStatus;
    startedAt?: string;
    finishedAt?: string;
    logUrl?: string;
    errorSummary?: string;
}
export interface PipelineRun {
    id: string;
    pipelineDefinitionId: string;
    projectId: string;
    jobId?: string;
    status: PipelineRunStatus;
    gitRef: string;
    commitSha?: string;
    jenkinsJobName: string;
    jenkinsBuildNumber?: number;
    jenkinsBuildUrl?: string;
    stages: PipelineStage[];
    resultSummary?: Record<string, unknown>;
}
export interface Release {
    id: string;
    projectId: string;
    version: string;
    commitSha: string;
    deployPackaging: DeployPackaging;
    imageTag?: string;
    imageDigest?: string;
    pm2AppName?: string;
    jenkinsBuildUrl?: string;
}
export interface Deployment {
    id: string;
    projectId: string;
    environment: string;
    releaseId: string;
    status: PipelineRunStatus;
    deployDriver: DeployDriver;
    commitSha: string;
    healthUrl: string;
    serverPath?: string;
    pm2AppName?: string;
    jenkinsBuildUrl?: string;
}
export interface Incident {
    id: string;
    projectId: string;
    environment: string;
    sourceJobId?: string;
    status: IncidentStatus;
    severity: 'warning' | 'critical';
    summary: string;
    source: 'alertmanager' | 'jenkins' | 'manual';
    labels: Record<string, string>;
    evidence: {
        lokiQuery?: string;
        prometheusQuery?: string;
        startsAt?: string;
        endsAt?: string;
        excerpt?: string;
    };
}
export interface CodexFix {
    id: string;
    incidentId: string;
    projectId: string;
    sourceJobId?: string;
    status: CodexFixStatus;
    diagnosis: string;
    fixType: 'config_fix' | 'code_fix' | 'pipeline_fix' | 'external_dependency';
    branchName?: string;
    baseBranch?: string;
    targetBranch?: string;
    pullRequestUrl?: string;
    pipelineRunId?: string;
}
export interface JenkinsBuildWebhook {
    pipelineRunId?: string;
    jobName: string;
    buildNumber: number;
    buildUrl: string;
    status: 'STARTED' | 'SUCCESS' | 'FAILURE' | 'ABORTED';
    gitRef?: string;
    commitSha?: string;
    stages?: Array<{
        name: string;
        status: 'SUCCESS' | 'FAILURE' | 'IN_PROGRESS' | 'ABORTED';
        startedAt?: string;
        finishedAt?: string;
        logUrl?: string;
        errorSummary?: string;
    }>;
    release?: {
        version?: string;
        imageTag?: string;
        imageDigest?: string;
        pm2AppName?: string;
        healthUrl?: string;
        serverPath?: string;
    };
}
