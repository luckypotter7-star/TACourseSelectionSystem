CREATE DATABASE IF NOT EXISTS ta_system
  DEFAULT CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE ta_system;

CREATE TABLE IF NOT EXISTS users (
  user_id INT PRIMARY KEY AUTO_INCREMENT,
  user_name VARCHAR(255) NOT NULL,
  login_name VARCHAR(255) NOT NULL UNIQUE,
  email VARCHAR(255) NOT NULL,
  password VARCHAR(255) NOT NULL,
  role VARCHAR(50) NOT NULL,
  is_allowed_to_apply CHAR(1) NOT NULL DEFAULT 'N',
  resume_name VARCHAR(255) NULL,
  resume_path VARCHAR(1024) NULL,
  INDEX idx_users_role (role),
  INDEX idx_users_login_name (login_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS classes (
  class_id INT PRIMARY KEY AUTO_INCREMENT,
  class_code VARCHAR(255) NOT NULL UNIQUE,
  class_abbr VARCHAR(255) NULL,
  class_name VARCHAR(255) NOT NULL,
  course_name VARCHAR(255) NOT NULL,
  teaching_language VARCHAR(100) NOT NULL,
  teacher_user_id VARCHAR(255) NOT NULL,
  teacher_name VARCHAR(255) NOT NULL,
  class_intro TEXT NULL,
  memo TEXT NULL,
  maximum_number_of_tas_admitted INT NOT NULL DEFAULT 1,
  ta_applications_allowed CHAR(1) NOT NULL DEFAULT 'Y',
  is_conflict_allowed CHAR(1) NOT NULL DEFAULT 'N',
  published_to_professor CHAR(1) NOT NULL DEFAULT 'N',
  professor_notified_at DATETIME NULL,
  apply_start_at DATETIME NULL,
  apply_end_at DATETIME NULL,
  semester VARCHAR(100) NOT NULL,
  INDEX idx_classes_code (class_code),
  INDEX idx_classes_semester (semester),
  INDEX idx_classes_teacher_name (teacher_name),
  INDEX idx_classes_published (published_to_professor)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS class_schedules (
  schedule_id INT PRIMARY KEY AUTO_INCREMENT,
  class_id INT NOT NULL,
  lesson_date DATE NOT NULL,
  start_time VARCHAR(16) NOT NULL,
  end_time VARCHAR(16) NOT NULL,
  section VARCHAR(100) NOT NULL,
  is_exam VARCHAR(100) NULL,
  CONSTRAINT fk_class_schedules_class
    FOREIGN KEY (class_id) REFERENCES classes(class_id)
    ON DELETE CASCADE,
  INDEX idx_class_schedules_class (class_id),
  INDEX idx_class_schedules_lesson_date (lesson_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS applications (
  application_id INT PRIMARY KEY AUTO_INCREMENT,
  applier_user_id INT NOT NULL,
  applier_name VARCHAR(255) NOT NULL,
  class_id INT NOT NULL,
  class_name VARCHAR(255) NOT NULL,
  teacher_user_id VARCHAR(255) NOT NULL,
  teacher_name VARCHAR(255) NOT NULL,
  application_reason TEXT NOT NULL,
  resume_name VARCHAR(255) NOT NULL,
  resume_path VARCHAR(1024) NULL,
  status VARCHAR(50) NOT NULL,
  submitted_at DATETIME NOT NULL,
  ta_comment TEXT NULL,
  ta_acted_at DATETIME NULL,
  prof_comment TEXT NULL,
  prof_acted_at DATETIME NULL,
  CONSTRAINT fk_applications_user
    FOREIGN KEY (applier_user_id) REFERENCES users(user_id),
  CONSTRAINT fk_applications_class
    FOREIGN KEY (class_id) REFERENCES classes(class_id)
    ON DELETE CASCADE,
  INDEX idx_applications_class (class_id),
  INDEX idx_applications_user (applier_user_id),
  INDEX idx_applications_status (status),
  INDEX idx_applications_submitted_at (submitted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS approval_logs (
  approval_log_id INT PRIMARY KEY AUTO_INCREMENT,
  application_id INT NOT NULL,
  approval_stage VARCHAR(50) NOT NULL,
  approver_user_id INT NOT NULL,
  approver_name VARCHAR(255) NOT NULL,
  result VARCHAR(50) NOT NULL,
  comments TEXT NULL,
  acted_at DATETIME NOT NULL,
  CONSTRAINT fk_approval_logs_application
    FOREIGN KEY (application_id) REFERENCES applications(application_id)
    ON DELETE CASCADE,
  INDEX idx_approval_logs_application (application_id),
  INDEX idx_approval_logs_acted_at (acted_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS notifications (
  notification_id INT PRIMARY KEY AUTO_INCREMENT,
  user_id INT NOT NULL,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  target_path VARCHAR(1024) NULL,
  is_read CHAR(1) NOT NULL DEFAULT 'N',
  created_at DATETIME NOT NULL,
  CONSTRAINT fk_notifications_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  INDEX idx_notifications_user (user_id),
  INDEX idx_notifications_is_read (is_read),
  INDEX idx_notifications_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  audit_log_id INT PRIMARY KEY AUTO_INCREMENT,
  actor_user_id INT NULL,
  actor_name VARCHAR(255) NULL,
  actor_role VARCHAR(50) NULL,
  action_type VARCHAR(100) NOT NULL,
  target_type VARCHAR(100) NOT NULL,
  target_id VARCHAR(255) NULL,
  target_name VARCHAR(255) NULL,
  details TEXT NULL,
  created_at DATETIME NOT NULL,
  INDEX idx_audit_logs_created_at (created_at),
  INDEX idx_audit_logs_action_type (action_type),
  INDEX idx_audit_logs_target_type (target_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS login_tokens (
  token VARCHAR(255) PRIMARY KEY,
  user_id INT NOT NULL,
  target_path VARCHAR(1024) NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  CONSTRAINT fk_login_tokens_user
    FOREIGN KEY (user_id) REFERENCES users(user_id)
    ON DELETE CASCADE,
  INDEX idx_login_tokens_user (user_id),
  INDEX idx_login_tokens_expires_at (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
