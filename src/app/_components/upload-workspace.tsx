"use client";

import { useUploadSession } from "./use-upload-session";
import {
  AppHeader,
  RecentJobs,
  UploadForm,
  UploadProgressList,
} from "./upload-workspace-ui";

export function UploadWorkspace() {
  const uploadSession = useUploadSession();

  return (
    <main className="min-h-screen bg-[#f6f7fb] text-[#11131a]">
      <AppHeader />

      <UploadForm
        prompt={uploadSession.prompt}
        targetLanguage={uploadSession.targetLanguage}
        selectedUploads={uploadSession.selectedUploads}
        rejectedItems={uploadSession.rejectedItems}
        uploadItems={uploadSession.uploadItems}
        formError={uploadSession.formError}
        isDragging={uploadSession.isDragging}
        isSubmitting={uploadSession.isSubmitting}
        canGenerate={uploadSession.canGenerate}
        selectedTotalSize={uploadSession.selectedTotalSize}
        onSubmit={uploadSession.submitUpload}
        onChooseVideos={uploadSession.chooseVideos}
        onDragEnter={uploadSession.handleDragEnter}
        onDragOver={uploadSession.handleDragOver}
        onDragLeave={uploadSession.handleDragLeave}
        onDrop={uploadSession.handleDrop}
        onPromptChange={uploadSession.setPrompt}
        onTargetLanguageChange={uploadSession.setTargetLanguage}
      />

      <UploadProgressList
        items={uploadSession.uploadItems}
        batchStatus={uploadSession.batchStatus}
        statusMessage={uploadSession.batchStatusMessage}
        downloadingVideoId={uploadSession.downloadingVideoId}
        downloadingInstructionPdfId={uploadSession.downloadingInstructionPdfId}
        retryingVideoId={uploadSession.retryingVideoId}
        onDownloadVideo={uploadSession.downloadVideo}
        onDownloadInstructionPdf={uploadSession.downloadInstructionPdf}
        onRetryProcessing={uploadSession.retryProcessing}
      />

      <RecentJobs
        items={uploadSession.videoHistory}
        isLoading={uploadSession.isLoadingHistory}
        message={uploadSession.historyMessage}
        activeBatchId={uploadSession.activeBatchId}
        onSelect={uploadSession.openHistoryBatch}
      />
    </main>
  );
}
